-- Bills, payroll, and provider connections.
--
-- Every table is household-scoped and RLS-protected using the same
-- current_household_ids() helper as 0001. The security tests assert this, and
-- any table added here without a policy will fail the build.
--
-- The unique constraints are the important part of this migration. Automated
-- ingestion re-reads overlapping windows by design, so without them the same
-- electric bill lands four times and "due before payday" is four times too high.

-- ---------------------------------------------------------------------------
-- Provider connections
--
-- Rows describe WHICH integrations exist and their health. Credentials never
-- live here — token_ref points into Vault, exactly as items.token_ref does.
-- ---------------------------------------------------------------------------

create type provider_kind as enum ('email', 'bills', 'payroll', 'documents', 'banking');
create type connection_status as enum ('connected', 'needs_reauth', 'error', 'disconnected');

create table provider_connections (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  provider_key  text not null,
  display_name  text not null,
  kind          provider_kind not null,
  -- False for mock adapters. The UI reads this to decide whether it may tell
  -- the household their accounts are actually connected.
  is_live       boolean not null default false,
  status        connection_status not null default 'disconnected',
  status_detail text,
  token_ref     text,
  cursor        text,
  connected_at  timestamptz,
  last_synced_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (household_id, provider_key)
);
create index on provider_connections (household_id, kind);

-- ---------------------------------------------------------------------------
-- Sync runs
-- ---------------------------------------------------------------------------

create type sync_kind as enum ('bills', 'payroll', 'paystubs', 'transactions');
create type sync_status as enum ('running', 'success', 'partial', 'error', 'skipped');

create table sync_runs (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references households(id) on delete cascade,
  connection_id  uuid references provider_connections(id) on delete set null,
  provider_key   text not null,
  kind           sync_kind not null,
  started_at     timestamptz not null default now(),
  completed_at   timestamptz,
  status         sync_status not null default 'running',
  items_found    int not null default 0,
  items_created  int not null default 0,
  items_updated  int not null default 0,
  items_skipped  int not null default 0,
  duplicates_detected int not null default 0,
  provider_is_live boolean not null default false,
  errors         jsonb not null default '[]'::jsonb,
  duration_ms    int
);
create index on sync_runs (household_id, started_at desc);
create index on sync_runs (household_id, provider_key, started_at desc);

-- ---------------------------------------------------------------------------
-- Bills
-- ---------------------------------------------------------------------------

create type bill_source_type as enum ('email', 'pdf', 'provider_api', 'provider_portal', 'manual');
create type bill_status as enum ('detected', 'confirmed', 'scheduled', 'paid', 'overdue', 'disputed', 'ignored');

-- A recurring bill relationship: "we get an electric bill from this provider".
-- Separate from individual bills so cadence and expected amounts can be learned
-- and a missing bill can be noticed.
create table bill_sources (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references households(id) on delete cascade,
  connection_id   uuid references provider_connections(id) on delete set null,
  provider_key    text not null,
  provider_name   text not null,
  category        text not null default 'Other',
  -- Last 4 only. A check constraint enforces it, because a full account number
  -- reaching this column is a security incident rather than a data-quality one.
  account_label   text check (account_label is null or length(account_label) <= 8),
  expected_cadence text,
  typical_amount  numeric(14,2),
  typical_due_day smallint check (typical_due_day between 1 and 31),
  is_active       boolean not null default true,
  autopay         boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (household_id, provider_key, account_label)
);
create index on bill_sources (household_id);

create table bills (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references households(id) on delete cascade,
  bill_source_id     uuid references bill_sources(id) on delete set null,
  provider_name      text not null,
  provider_key       text not null,
  category           text not null default 'Other',
  account_label      text check (account_label is null or length(account_label) <= 8),
  amount_due         numeric(14,2) not null check (amount_due >= 0),
  currency           text not null default 'USD',
  due_date           date not null,
  statement_date     date,
  statement_period_start date,
  statement_period_end   date,
  status             bill_status not null default 'detected',
  source             bill_source_type not null,
  source_message_id  text,
  source_document_id text,
  -- 0..1. Below 0.7 the UI asks for confirmation rather than budgeting against it.
  confidence         numeric(4,3) not null default 0 check (confidence between 0 and 1),
  needs_review       boolean not null default false,
  detected_at        timestamptz not null default now(),
  paid_at            timestamptz,
  paid_amount        numeric(14,2),
  -- Links a bill to the bank transaction that paid it.
  paid_transaction_id uuid references transactions(id) on delete set null,
  notes              text,
  raw                jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Business identity: one provider does not bill the same amount on the same
-- date twice. This is the constraint that survives a re-sync.
create unique index bills_identity_key
  on bills (household_id, provider_key, due_date, amount_due);

-- Source identity: the same email or document is never imported twice.
create unique index bills_source_message_key
  on bills (household_id, source, source_message_id)
  where source_message_id is not null;

create index on bills (household_id, due_date);
create index on bills (household_id, status, due_date);
create index on bills (bill_source_id);
-- The review queue.
create index on bills (household_id, due_date) where needs_review = true;

-- Audit trail of every import attempt, including rejected ones. Kept separate
-- from bills so a duplicate or a failed parse leaves a trace rather than
-- vanishing — "why didn't my water bill show up" needs an answer.
create table bill_imports (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references households(id) on delete cascade,
  sync_run_id    uuid references sync_runs(id) on delete cascade,
  bill_id        uuid references bills(id) on delete set null,
  source         bill_source_type not null,
  source_ref     text,
  outcome        text not null check (outcome in ('created', 'updated', 'duplicate', 'needs_review', 'rejected')),
  reason         text,
  parsed_fields  jsonb,
  confidence     numeric(4,3),
  created_at     timestamptz not null default now()
);
create index on bill_imports (household_id, created_at desc);
create index on bill_imports (sync_run_id);

create table bill_payments (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references households(id) on delete cascade,
  bill_id        uuid not null references bills(id) on delete cascade,
  transaction_id uuid references transactions(id) on delete set null,
  amount         numeric(14,2) not null,
  paid_on        date not null,
  method         text,
  confirmed      boolean not null default false,
  created_at     timestamptz not null default now()
);
create index on bill_payments (household_id, paid_on desc);
create index on bill_payments (bill_id);

-- ---------------------------------------------------------------------------
-- Payroll
-- ---------------------------------------------------------------------------

create type time_entry_source as enum ('manual', 'timecard_import', 'provider_api', 'estimated');

create table pay_profiles (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid not null references households(id) on delete cascade,
  user_id             uuid references auth.users(id) on delete set null,
  connection_id       uuid references provider_connections(id) on delete set null,
  label               text not null,
  employer_name       text,
  base_hourly_rate    numeric(10,4) not null check (base_hourly_rate > 0),
  overtime_multiplier numeric(5,2) not null default 1.5,
  double_time_multiplier numeric(5,2) default 2.0,
  -- 0 disables daily overtime. The correct default for a compressed schedule:
  -- an 8-hour threshold turns every 10-hour shift into 2 phantom OT hours.
  daily_overtime_threshold numeric(5,2) not null default 0,
  weekly_overtime_threshold numeric(5,2) not null default 40,
  standby_rate        numeric(10,4) not null default 0,
  standby_is_daily    boolean not null default false,
  -- Paid minimum per callback event, regardless of time actually worked.
  callback_minimum_hours numeric(5,2) not null default 0,
  callback_multiplier numeric(5,2) not null default 1.5,
  holiday_multiplier  numeric(5,2) not null default 1.5,
  differential_rates  jsonb not null default '{}'::jsonb,
  recurring_deductions jsonb not null default '[]'::jsonb,
  tax_assumptions     jsonb not null default '{}'::jsonb,
  pay_frequency       pay_cadence not null default 'biweekly',
  pay_period_start    date,
  pay_period_end      date,
  payday              date,
  payday_lag_days     smallint,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index on pay_profiles (household_id);

create table pay_periods (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references households(id) on delete cascade,
  pay_profile_id  uuid not null references pay_profiles(id) on delete cascade,
  period_start    date not null,
  period_end      date not null,
  pay_date        date not null,
  status          text not null default 'open' check (status in ('open', 'submitted', 'paid')),
  created_at      timestamptz not null default now(),
  unique (pay_profile_id, period_start)
);
create index on pay_periods (household_id, pay_date desc);

create table time_entries (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references households(id) on delete cascade,
  pay_profile_id  uuid not null references pay_profiles(id) on delete cascade,
  pay_period_id   uuid references pay_periods(id) on delete set null,
  entry_date      date not null,
  start_time      time,
  end_time        time,
  regular_hours   numeric(6,2) not null default 0 check (regular_hours >= 0),
  overtime_hours  numeric(6,2) not null default 0 check (overtime_hours >= 0),
  -- Hours ON CALL, not worked. May legitimately span a full 24-hour day
  -- alongside worked hours, so it is excluded from the worked-hours check.
  standby_hours   numeric(6,2) not null default 0 check (standby_hours >= 0),
  callback_hours  numeric(6,2) not null default 0 check (callback_hours >= 0),
  callback_events smallint not null default 0 check (callback_events >= 0),
  holiday_hours   numeric(6,2) not null default 0 check (holiday_hours >= 0),
  pto_hours       numeric(6,2) not null default 0 check (pto_hours >= 0),
  differential_code text,
  differential_hours numeric(6,2) not null default 0,
  notes           text,
  source          time_entry_source not null default 'manual',
  source_ref      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint worked_hours_within_a_day check (
    regular_hours + overtime_hours + callback_hours + holiday_hours + pto_hours <= 24
  )
);

-- One entry per profile per day. Re-importing a timecard corrects the day
-- rather than appending a second copy of it.
create unique index time_entries_profile_date_key
  on time_entries (pay_profile_id, entry_date);
create index on time_entries (household_id, entry_date desc);
create index on time_entries (pay_period_id);

create table paycheck_forecasts (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references households(id) on delete cascade,
  pay_profile_id   uuid not null references pay_profiles(id) on delete cascade,
  pay_period_id    uuid references pay_periods(id) on delete set null,
  pay_date         date not null,
  period_start     date not null,
  period_end       date not null,
  total_gross      numeric(14,2) not null,
  total_taxes      numeric(14,2) not null,
  total_deductions numeric(14,2) not null,
  estimated_net    numeric(14,2) not null,
  breakdown        jsonb not null,
  confidence       text not null check (confidence in ('high', 'medium', 'low')),
  confidence_score numeric(4,3),
  confidence_reasons jsonb not null default '[]'::jsonb,
  days_covered     smallint,
  days_in_period   smallint,
  period_complete  boolean not null default false,
  created_at       timestamptz not null default now(),
  -- One current forecast per period; recomputing replaces it.
  unique (pay_profile_id, pay_date, period_start)
);
create index on paycheck_forecasts (household_id, pay_date desc);

create table paystubs (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references households(id) on delete cascade,
  pay_profile_id  uuid references pay_profiles(id) on delete set null,
  pay_period_id   uuid references pay_periods(id) on delete set null,
  pay_date        date not null,
  period_start    date not null,
  period_end      date not null,
  gross_pay       numeric(14,2) not null check (gross_pay >= 0),
  net_pay         numeric(14,2) not null,
  total_taxes     numeric(14,2) not null default 0,
  regular_hours   numeric(6,2),
  overtime_hours  numeric(6,2),
  earnings        jsonb not null default '{}'::jsonb,
  source          text not null check (source in ('manual', 'pdf', 'provider_api', 'email')),
  source_ref      text,
  confidence      numeric(4,3) not null default 1,
  created_at      timestamptz not null default now(),
  constraint net_not_above_gross check (net_pay <= gross_pay)
);

-- One stub per profile per pay date and period. Two paychecks can be identical
-- amounts, but not for the same period.
create unique index paystubs_identity_key
  on paystubs (household_id, coalesce(pay_profile_id, '00000000-0000-0000-0000-000000000000'::uuid), pay_date, period_start);
create unique index paystubs_source_ref_key
  on paystubs (household_id, source_ref) where source_ref is not null;
create index on paystubs (household_id, pay_date desc);

create table deductions (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  paystub_id   uuid not null references paystubs(id) on delete cascade,
  label        text not null,
  amount       numeric(14,2) not null,
  pre_tax      boolean not null default false,
  category     text,
  created_at   timestamptz not null default now()
);
create index on deductions (paystub_id);
create index on deductions (household_id, label);

-- Expected vs actual, retained so recurring discrepancies can be learned.
create table paycheck_reconciliations (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null references households(id) on delete cascade,
  paystub_id        uuid not null references paystubs(id) on delete cascade,
  forecast_id       uuid references paycheck_forecasts(id) on delete set null,
  expected_gross    numeric(14,2) not null,
  actual_gross      numeric(14,2) not null,
  expected_net      numeric(14,2) not null,
  actual_net        numeric(14,2) not null,
  expected_taxes    numeric(14,2) not null,
  actual_taxes      numeric(14,2) not null,
  expected_deductions numeric(14,2) not null,
  actual_deductions numeric(14,2) not null,
  material_variance boolean not null default false,
  findings          jsonb not null default '[]'::jsonb,
  derived_rates     jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  unique (paystub_id)
);
create index on paycheck_reconciliations (household_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Income sources
--
-- Broader than income_streams (0001), which is inferred from bank deposits.
-- This is the configured view: which pay profile or other source produces
-- income, so the budget can reason about income that has not yet been observed.
-- ---------------------------------------------------------------------------

create table income_sources (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references households(id) on delete cascade,
  pay_profile_id  uuid references pay_profiles(id) on delete set null,
  income_stream_id uuid references income_streams(id) on delete set null,
  label           text not null,
  kind            text not null default 'employment'
                    check (kind in ('employment', 'self_employment', 'benefit', 'rental', 'other')),
  cadence         pay_cadence,
  is_variable     boolean not null default false,
  -- Conservative planning figure (p20) for variable income; bills are planned
  -- against this rather than an average.
  floor_amount    numeric(14,2),
  typical_amount  numeric(14,2),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);
create index on income_sources (household_id);

-- ---------------------------------------------------------------------------
-- RLS — every table, same household scoping as 0001
-- ---------------------------------------------------------------------------

alter table provider_connections      enable row level security;
alter table sync_runs                 enable row level security;
alter table bill_sources              enable row level security;
alter table bills                     enable row level security;
alter table bill_imports              enable row level security;
alter table bill_payments             enable row level security;
alter table pay_profiles              enable row level security;
alter table pay_periods               enable row level security;
alter table time_entries              enable row level security;
alter table paycheck_forecasts        enable row level security;
alter table paystubs                  enable row level security;
alter table deductions                enable row level security;
alter table paycheck_reconciliations  enable row level security;
alter table income_sources            enable row level security;

create policy provider_connection_access on provider_connections
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy sync_run_access on sync_runs
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy bill_source_access on bill_sources
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy bill_access on bills
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy bill_import_access on bill_imports
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy bill_payment_access on bill_payments
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy pay_profile_access on pay_profiles
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy pay_period_access on pay_periods
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy time_entry_access on time_entries
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy paycheck_forecast_access on paycheck_forecasts
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy paystub_access on paystubs
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy deduction_access on deductions
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy reconciliation_access on paycheck_reconciliations
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy income_source_access on income_sources
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- Bills that count toward what is owed. Excludes paid, ignored, and anything
-- still awaiting review, so an unconfirmed low-confidence parse never silently
-- moves a budget total.
create view active_bills as
select b.*
from bills b
where b.status not in ('paid', 'ignored')
  and b.needs_review = false;

-- Latest sync per provider, for "Electricity — 12 minutes ago".
create view provider_sync_status as
select distinct on (household_id, provider_key)
  household_id,
  provider_key,
  kind,
  status,
  provider_is_live,
  started_at,
  completed_at,
  items_created,
  errors
from sync_runs
order by household_id, provider_key, started_at desc;
