-- Invite-only signup.
--
-- The app is deployed to a public URL, so anyone who finds it can reach the
-- signup form. Nothing there could read another household's data — RLS sees to
-- that — but there is no reason to let strangers create accounts on a two-person
-- project, and every account that exists is one more thing to reason about.
--
-- Enforced by a `before-user-created` auth hook rather than by hiding the form,
-- because the publishable key is public by design: anyone can call
-- supabase.auth.signUp() directly regardless of what the UI shows. The check has
-- to live on the server side of that boundary or it is decoration.
--
-- Deliberately NOT the project-wide "disable signups" switch. That blocks the
-- invited partner too, leaving admin-generated invite emails as the only way in
-- — which needs an email provider this project does not have configured. Gating
-- on an invite list keeps self-service signup working for exactly the people who
-- were invited, and nobody else.

create table household_invites (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  email        text not null,
  invited_by   uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '14 days',
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users(id) on delete set null
);

-- One live invite per address. Accepted and expired rows stay for the audit
-- trail, so the constraint is partial rather than a plain unique column.
create unique index household_invites_one_pending_per_email
  on household_invites (lower(email))
  where accepted_at is null;

create index household_invites_household on household_invites (household_id);

alter table household_invites enable row level security;

create policy invite_access on household_invites
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

grant select, insert, update, delete on household_invites to authenticated;

-- ---------------------------------------------------------------------------
-- The hook itself
-- ---------------------------------------------------------------------------
--
-- Wired up in Dashboard → Authentication → Hooks → "Before user created".
-- Until it is selected there this function is inert, and signup stays open.
--
-- SECURITY DEFINER so it can read auth.users and household_invites: it runs as
-- supabase_auth_admin, which is subject to RLS on household_invites and has no
-- membership of anything.

create or replace function public.hook_restrict_signup(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate_email text;
  existing_users   bigint;
  matching_invites bigint;
begin
  candidate_email := lower(trim(event -> 'user' ->> 'email'));

  -- The first account bootstraps the household. There is nobody to invite them
  -- and no invite they could hold, so this is the one signup that is allowed
  -- unconditionally. It closes permanently the moment that account exists.
  select count(*) into existing_users from auth.users;
  if existing_users = 0 then
    return '{}'::jsonb;
  end if;

  if candidate_email is null or candidate_email = '' then
    return jsonb_build_object('error', jsonb_build_object(
      'message', 'This app is invite-only.',
      'http_code', 403));
  end if;

  select count(*) into matching_invites
  from household_invites
  where lower(email) = candidate_email
    and accepted_at is null
    and expires_at > now();

  if matching_invites > 0 then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object('error', jsonb_build_object(
    'message', 'This app is invite-only. Ask someone in the household to send you an invite.',
    'http_code', 403));
end;
$$;

-- Only the auth server may call it. Exposing it to authenticated would let a
-- signed-in user probe which addresses hold a pending invite.
revoke execute on function public.hook_restrict_signup(jsonb) from public, anon, authenticated;
grant execute on function public.hook_restrict_signup(jsonb) to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- Issuing an invite
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER because it checks auth.users for an existing membership,
-- which an ordinary caller cannot read. The household is taken from the
-- caller's own membership and never from an argument, so this cannot be used to
-- add someone to a household the caller does not belong to.

create or replace function create_household_invite(invite_email text)
returns household_invites
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_household uuid;
  normalized       text;
  result           household_invites;
begin
  normalized := lower(trim(invite_email));

  if normalized !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'That does not look like an email address.'
      using errcode = 'check_violation';
  end if;

  select household_id into caller_household
  from household_members
  where user_id = auth.uid()
  limit 1;

  if caller_household is null then
    raise exception 'You are not in a household yet.'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1
    from auth.users u
    join household_members m on m.user_id = u.id
    where lower(u.email) = normalized
      and m.household_id = caller_household
  ) then
    raise exception 'That person is already in your household.'
      using errcode = 'unique_violation';
  end if;

  -- Re-inviting the same address replaces the old pending invite rather than
  -- tripping the unique index. Scoped to this household so one household can
  -- never clear another's pending invite.
  delete from household_invites
  where lower(email) = normalized
    and accepted_at is null
    and household_id = caller_household;

  insert into household_invites (household_id, email, invited_by)
  values (caller_household, normalized, auth.uid())
  returning * into result;

  return result;
end;
$$;

revoke all on function create_household_invite(text) from public, anon;
grant execute on function create_household_invite(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Joining, rather than creating, when invited
-- ---------------------------------------------------------------------------
--
-- Replaces 0005's version. That one created a household for every new user,
-- which for the second person in a couple is precisely wrong: they would sign
-- in successfully, see an empty dashboard, and have no indication that they
-- were looking at a different household than their partner.

create or replace function bootstrap_household(display_name text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_id       uuid;
  invite_id         uuid;
  invited_household uuid;
  new_id            uuid;
begin
  select household_id into existing_id
  from household_members
  where user_id = auth.uid()
  limit 1;

  if existing_id is not null then
    return existing_id;
  end if;

  select id, household_id into invite_id, invited_household
  from household_invites
  where lower(email) = lower(auth.email())
    and accepted_at is null
    and expires_at > now()
  order by created_at desc
  limit 1;

  if invited_household is not null then
    insert into household_members (household_id, user_id, display_name)
    values (invited_household, auth.uid(),
            coalesce(display_name, split_part(auth.email(), '@', 1)))
    on conflict (household_id, user_id) do nothing;

    update household_invites
    set accepted_at = now(),
        accepted_by = auth.uid()
    where id = invite_id;

    return invited_household;
  end if;

  insert into households (name) values ('Our Household') returning id into new_id;

  insert into household_members (household_id, user_id, display_name)
  values (new_id, auth.uid(), coalesce(display_name, split_part(auth.email(), '@', 1)));

  return new_id;
end;
$$;

revoke all on function bootstrap_household(text) from public;
revoke all on function bootstrap_household(text) from anon;
grant execute on function bootstrap_household(text) to authenticated;
