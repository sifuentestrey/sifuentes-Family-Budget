-- Server-only configuration. No browser or Budget user gets access to this key hash.
create schema family_board_private;
revoke all on schema family_board_private from public,anon,authenticated;
grant usage on schema family_board_private to service_role;

create table family_board_private.bill_bridge (
  name text primary key check (name='family-board'),
  household_id uuid not null,
  actor_user_id uuid not null,
  token_sha256 text not null check (token_sha256 ~ '^[0-9a-f]{64}$'),
  enabled boolean not null default true,
  foreign key (household_id,actor_user_id)
    references public.household_members(household_id,user_id) on delete cascade
);
create index bill_bridge_member on family_board_private.bill_bridge(household_id,actor_user_id);
alter table family_board_private.bill_bridge enable row level security;
revoke all on family_board_private.bill_bridge from public,anon,authenticated;
grant select on family_board_private.bill_bridge to service_role;

-- SECURITY INVOKER: only the Edge Function's service role can read the private config.
create function public.family_board_bill_bridge_config()
returns table (household_id uuid,actor_user_id uuid,token_sha256 text,enabled boolean)
language sql stable security invoker set search_path=''
as $$ select household_id,actor_user_id,token_sha256,enabled
  from family_board_private.bill_bridge where name='family-board' $$;
revoke all on function public.family_board_bill_bridge_config() from public,anon,authenticated;
grant execute on function public.family_board_bill_bridge_config() to service_role;
grant select on public.family_board_bill_events to service_role;
grant insert(id,household_id,kind,data,created_by) on public.family_board_bill_events to service_role;
