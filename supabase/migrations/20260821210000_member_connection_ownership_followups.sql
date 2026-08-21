-- Follow-up to member-owned connections.
--
-- The composite owner constraints must not prevent a person from leaving a
-- household. Sources remain in the household as explicitly shared/unassigned
-- rather than becoming orphaned or blocking removal. New accounts discovered
-- during a normal Plaid sync inherit the Item owner in sync-transactions.

alter table public.items
  drop constraint if exists items_owner_household_member_fkey;
alter table public.provider_connections
  drop constraint if exists provider_connections_owner_household_member_fkey;
alter table public.oauth_states
  drop constraint if exists oauth_states_owner_household_member_fkey;
alter table public.accounts
  drop constraint if exists accounts_owner_household_member_fkey;

alter table public.items
  add constraint items_owner_household_member_fkey
  foreign key (household_id, owner_user_id)
  references public.household_members (household_id, user_id)
  on delete set null (owner_user_id);

alter table public.provider_connections
  add constraint provider_connections_owner_household_member_fkey
  foreign key (household_id, owner_user_id)
  references public.household_members (household_id, user_id)
  on delete set null (owner_user_id);

alter table public.oauth_states
  add constraint oauth_states_owner_household_member_fkey
  foreign key (household_id, owner_user_id)
  references public.household_members (household_id, user_id)
  on delete set null (owner_user_id);

alter table public.accounts
  add constraint accounts_owner_household_member_fkey
  foreign key (household_id, owner_user_id)
  references public.household_members (household_id, user_id)
  on delete set null (owner_user_id);
