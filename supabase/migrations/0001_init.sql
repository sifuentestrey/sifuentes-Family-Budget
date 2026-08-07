-- Family Budget — initial schema
--
-- Design notes:
--   * Every table is RLS-protected and scoped to a household. Two spouses share one
--     household; nobody outside it can read a single row.
--   * We never store full account numbers. Nicknames + last-4 only.
--   * Plaid access tokens live in Supabase secrets / Vault, NOT in these tables.
--     `items.token_ref` is a lookup key, not the token itself.

-- ---------------------------------------------------------------------------
-- Household + membership
-- ---------------------------------------------------------------------------

create table households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table household_members (
  household_id uuid not null references households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  created_at   timestamptz not null default now(),
  primary key (household_id, user_id)
);

-- Helper used by every RLS policy. SECURITY DEFINER so the policy can read
-- membership without recursively triggering its own RLS check.
create or replace function current_household_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id from household_members where user_id = auth.uid()
$$;

-- ---------------------------------------------------------------------------
-- Plaid institution connections
-- ---------------------------------------------------------------------------

create type item_status as enum ('good', 'login_required', 'error', 'revoked');

create table items (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references households(id) on delete cascade,
  plaid_item_id   text not null unique,
  institution_id  text,
  institution_name text not null,
  -- Key into Supabase Vault where the access token actually lives.
  -- Storing the token here would put it in every DB backup and PostgREST response.
  token_ref       text not null,
  -- Plaid /transactions/sync cursor. Null means "never synced, pull full history".
  cursor          text,
  status          item_status not null default 'good',
  status_detail   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index on items (household_id);

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

create type account_type as enum ('checking', 'savings', 'credit', 'loan', 'other');

create table accounts (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references households(id) on delete cascade,
  item_id          uuid not null references items(id) on delete cascade,
  plaid_account_id text not null unique,
  nickname         text not null,
  type             account_type not null,
  -- Last 4 only. Never the full number.
  mask             text check (mask is null or length(mask) <= 4),
  institution_name text,
  -- Whose account this primarily is, for per-person views. Null = joint.
  owner_user_id    uuid references auth.users(id) on delete set null,
  current_balance  numeric(14,2),
  available_balance numeric(14,2),
  -- Credit-only fields
  credit_limit     numeric(14,2),
  apr              numeric(6,3),
  due_day          smallint check (due_day between 1 and 31),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index on accounts (household_id);
create index on accounts (item_id);

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------

-- fixed    = same amount every month (rent, insurance)
-- variable = fluctuates (groceries, gas)
-- sinking  = irregular, saved toward monthly (car registration, holidays)
create type category_kind as enum ('fixed', 'variable', 'sinking', 'income', 'transfer');

create table categories (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  name          text not null,
  category_group text not null,
  kind          category_kind not null default 'variable',
  monthly_target numeric(14,2),
  sort_order    int not null default 0,
  is_archived   boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (household_id, name)
);

create index on categories (household_id);

-- ---------------------------------------------------------------------------
-- Categorization rules
-- ---------------------------------------------------------------------------

-- 'learned' rules are written when a human recategorizes a transaction. They
-- outrank everything else and are never overwritten by an automated layer.
create table rules (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  -- Matched against the cleaned payee, case-insensitive.
  pattern      text not null,
  match_type   text not null default 'contains' check (match_type in ('exact', 'contains', 'regex')),
  category_id  uuid not null references categories(id) on delete cascade,
  -- Lower number = evaluated first. Learned rules get priority 0.
  priority     int not null default 100,
  is_learned   boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (household_id, pattern, match_type)
);

create index on rules (household_id, priority);

-- ---------------------------------------------------------------------------
-- Transactions
-- ---------------------------------------------------------------------------

-- Which layer assigned the category. Makes every category traceable — the user
-- can always answer "why is this here?".
create type categorized_by as enum ('learned', 'rule', 'plaid_pfc', 'llm', 'split', 'none');

create table transactions (
  id                    uuid primary key default gen_random_uuid(),
  household_id          uuid not null references households(id) on delete cascade,
  account_id            uuid not null references accounts(id) on delete cascade,
  -- Unique key from Plaid. Makes re-syncs idempotent.
  -- Null for split child rows, which have no Plaid counterpart.
  plaid_transaction_id  text unique,

  posted_date           date not null,
  -- Positive = money out (spending). Negative = money in (deposit/refund).
  -- Matches Plaid's sign convention; keeping it avoids a translation bug class.
  amount                numeric(14,2) not null,

  raw_description       text not null,
  payee                 text not null,

  category_id           uuid references categories(id) on delete set null,
  categorized_by        categorized_by not null default 'none',

  is_transfer           boolean not null default false,
  -- The other side of a detected transfer pair.
  transfer_pair_id      uuid references transactions(id) on delete set null,
  is_income             boolean not null default false,

  -- True once a human sets the category. Automated layers must never overwrite.
  manually_categorized  boolean not null default false,

  -- Split children point at their parent. Parent keeps the original amount but
  -- is excluded from category totals; children carry the categorized amounts.
  parent_transaction_id uuid references transactions(id) on delete cascade,

  pending               boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index on transactions (household_id, posted_date desc);
create index on transactions (account_id);
create index on transactions (category_id);
create index on transactions (parent_transaction_id);
-- Review queue: uncategorized rows, most recent first.
create index on transactions (household_id, posted_date desc)
  where category_id is null and parent_transaction_id is null;

-- ---------------------------------------------------------------------------
-- Detected income streams
-- ---------------------------------------------------------------------------

create type pay_cadence as enum ('weekly', 'biweekly', 'semimonthly', 'monthly', 'irregular');

create table income_streams (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references households(id) on delete cascade,
  account_id     uuid not null references accounts(id) on delete cascade,
  payee          text not null,
  cadence        pay_cadence not null,
  -- Median net deposit. Median not mean: one bonus shouldn't skew the forecast.
  typical_amount numeric(14,2) not null,
  last_seen      date not null,
  next_expected  date,
  confirmed      boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (household_id, account_id, payee)
);

create index on income_streams (household_id);

-- ---------------------------------------------------------------------------
-- Sync log — silent sync failure is how a tool like this quietly becomes wrong
-- ---------------------------------------------------------------------------

create table sync_log (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  item_id       uuid references items(id) on delete set null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null check (status in ('running', 'success', 'error')),
  added         int not null default 0,
  modified      int not null default 0,
  removed       int not null default 0,
  error_message text
);

create index on sync_log (household_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security — every table, no exceptions
-- ---------------------------------------------------------------------------

alter table households        enable row level security;
alter table household_members enable row level security;
alter table items             enable row level security;
alter table accounts          enable row level security;
alter table categories        enable row level security;
alter table rules             enable row level security;
alter table transactions      enable row level security;
alter table income_streams    enable row level security;
alter table sync_log          enable row level security;

create policy household_access on households
  for all using (id in (select current_household_ids()))
  with check (id in (select current_household_ids()));

create policy member_access on household_members
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

-- Same shape for every household-scoped table.
create policy item_access on items
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy account_access on accounts
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy category_access on categories
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy rule_access on rules
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy transaction_access on transactions
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

create policy income_access on income_streams
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

-- Read-only to clients; only the service-role sync function writes here.
create policy sync_log_read on sync_log
  for select using (household_id in (select current_household_ids()));

-- ---------------------------------------------------------------------------
-- Spending view — the single source of truth for every total in the app.
--
-- Three exclusions, each of which is a real bug if omitted:
--   1. transfers      — a credit card payment is not spending; the spend already
--                       happened at the swipe. Counting both inflates monthly
--                       spend by whatever you pay the cards.
--   2. income         — deposits are not negative spending.
--   3. split parents  — the children carry the categorized amounts; counting the
--                       parent too would double every split.
-- ---------------------------------------------------------------------------

create view spending_transactions as
select t.*
from transactions t
where t.is_transfer = false
  and t.is_income = false
  and t.pending = false
  and not exists (
    select 1 from transactions c where c.parent_transaction_id = t.id
  );
