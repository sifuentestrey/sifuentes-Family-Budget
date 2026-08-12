-- Budget targets: what this household means to spend on a category each month.
--
-- These started on the device, in localStorage, which was fine for one person
-- on one phone and wrong for the thing this app is actually for. A budget is
-- an agreement between two people; a target only one of them can see is not
-- an agreement, and "why does your phone say $400 and mine says $550" is the
-- exact argument the app exists to prevent.
--
-- One row per household per category, so setting a target twice updates it
-- rather than accumulating history — a target is current intent, and the
-- record of what was actually spent already lives in transactions.
create table budget_targets (
  household_id  uuid not null references households(id) on delete cascade,
  category      text not null,
  amount        numeric(12,2) not null check (amount >= 0),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id) on delete set null,
  primary key (household_id, category)
);

alter table budget_targets enable row level security;

create policy budget_target_access on budget_targets
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));
