-- Monthly bill tracker storage for the existing family-budget project.
-- New tracker records only; bank transactions and existing budget bills are unchanged.

create table public.family_board_bill_events (
  id uuid primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references auth.users(id),
  kind text not null check (kind in ('billSet','billMonth','billPaid','billRemove','billAllocation','billExclude')),
  data jsonb not null check (
    jsonb_typeof(data) = 'object'
    and pg_column_size(data) <= 20000
    and coalesce(data->>'bid','') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
    and coalesce(data->>'month','') ~ '^(19|[2-9][0-9])[0-9]{2}-(0[1-9]|1[0-2])$'
  )
);
create index family_board_bill_events_household_history
  on public.family_board_bill_events (household_id,created_at,id);
create index family_board_bill_events_author
  on public.family_board_bill_events (created_by);
alter table public.family_board_bill_events enable row level security;
revoke all on public.family_board_bill_events from anon,authenticated;
grant select on public.family_board_bill_events to authenticated;
-- Defaults establish the real author and server time; clients cannot backdate either.
grant insert (id,household_id,kind,data) on public.family_board_bill_events to authenticated;
create policy family_board_bill_events_read on public.family_board_bill_events
  for select to authenticated
  using (household_id in (select public.current_household_ids()));
create policy family_board_bill_events_append on public.family_board_bill_events
  for insert to authenticated
  with check (created_by = (select auth.uid())
    and household_id in (select public.current_household_ids()));
-- Corrections append a new event. Clients receive no UPDATE or DELETE grants.
