-- Make external connections explicitly member-owned so a household can safely
-- combine multiple spouses' banks, inboxes, and payroll sources without
-- confusing ownership. Ownership stays nullable for true household/system
-- sources, but when present it must point to a member of the same household.

alter table public.items
  add column if not exists owner_user_id uuid;

alter table public.provider_connections
  add column if not exists owner_user_id uuid;

alter table public.oauth_states
  add column if not exists owner_user_id uuid;

-- Existing production data belongs to the sole current household member.
-- This backfill only fires for households with exactly one member, so future
-- multi-member households are never guessed.
with sole_members as (
  select household_id, min(user_id::text)::uuid as user_id
  from public.household_members
  group by household_id
  having count(*) = 1
)
update public.items i
set owner_user_id = s.user_id
from sole_members s
where i.household_id = s.household_id
  and i.owner_user_id is null;

with sole_members as (
  select household_id, min(user_id::text)::uuid as user_id
  from public.household_members
  group by household_id
  having count(*) = 1
)
update public.accounts a
set owner_user_id = s.user_id
from sole_members s
where a.household_id = s.household_id
  and a.owner_user_id is null;

with sole_members as (
  select household_id, min(user_id::text)::uuid as user_id
  from public.household_members
  group by household_id
  having count(*) = 1
)
update public.provider_connections c
set owner_user_id = s.user_id
from sole_members s
where c.household_id = s.household_id
  and c.owner_user_id is null;

with sole_members as (
  select household_id, min(user_id::text)::uuid as user_id
  from public.household_members
  group by household_id
  having count(*) = 1
)
update public.oauth_states o
set owner_user_id = s.user_id
from sole_members s
where o.household_id = s.household_id
  and o.owner_user_id is null;

-- Composite membership constraints prevent assigning a connection/account to
-- a user who is not actually in that household.
alter table public.items
  add constraint items_owner_household_member_fkey
  foreign key (household_id, owner_user_id)
  references public.household_members (household_id, user_id)
  not valid;

alter table public.provider_connections
  add constraint provider_connections_owner_household_member_fkey
  foreign key (household_id, owner_user_id)
  references public.household_members (household_id, user_id)
  not valid;

alter table public.oauth_states
  add constraint oauth_states_owner_household_member_fkey
  foreign key (household_id, owner_user_id)
  references public.household_members (household_id, user_id)
  not valid;

alter table public.accounts
  add constraint accounts_owner_household_member_fkey
  foreign key (household_id, owner_user_id)
  references public.household_members (household_id, user_id)
  not valid;

alter table public.items validate constraint items_owner_household_member_fkey;
alter table public.provider_connections validate constraint provider_connections_owner_household_member_fkey;
alter table public.oauth_states validate constraint oauth_states_owner_household_member_fkey;
alter table public.accounts validate constraint accounts_owner_household_member_fkey;

create index if not exists items_household_owner_idx
  on public.items (household_id, owner_user_id);
create index if not exists provider_connections_household_owner_idx
  on public.provider_connections (household_id, owner_user_id);
create index if not exists accounts_household_owner_idx
  on public.accounts (household_id, owner_user_id);

-- Retire duplicate scheduled AI reasoning. Keep both Edge Functions deployed
-- for rollback/manual diagnostics; only their autonomous schedules are paused.
select cron.alter_job(jobid, active => false)
from cron.job
where jobname in ('daily-llm-categorize', 'daily-advisor-checkin');
