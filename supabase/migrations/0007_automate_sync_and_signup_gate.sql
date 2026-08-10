-- Remove the two remaining manual setup steps.
--
-- Both existed because the thing they configure lives in project settings
-- rather than in the database. Moving each into Postgres makes it apply on
-- migration instead of waiting on someone to click through a dashboard.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- The sync secret moves from an environment variable into Vault
-- ---------------------------------------------------------------------------
--
-- sync-transactions compared the bearer token against Deno.env SYNC_SECRET.
-- That variable was never set, so the comparison was against the string
-- "Bearer undefined" — which anyone could send. Verified against the live
-- function before this change: it returned 200.
--
-- Holding the secret in Vault instead fixes the immediate hole and removes the
-- reason the schedule could not be created automatically: the scheduler and
-- the function can now both reach the same value without either of them
-- needing a project-level setting.

do $$
begin
  -- Only mint one if none exists, so re-running never rotates a working secret.
  if not exists (select 1 from vault.secrets where name = 'sync_secret') then
    perform vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'sync_secret',
      'Bearer token the scheduler presents to sync-transactions'
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The daily sync schedule
-- ---------------------------------------------------------------------------
--
-- 09:00 UTC is early morning US, after overnight posting has settled. Plaid
-- refreshes roughly daily, so syncing more often spends quota for no new data.
--
-- Side benefit: Supabase pauses free-tier projects after ~7 days of
-- inactivity, and a daily job keeps this one awake.

select cron.unschedule('daily-transaction-sync')
where exists (select 1 from cron.job where jobname = 'daily-transaction-sync');

select cron.schedule(
  'daily-transaction-sync',
  '0 9 * * *',
  $job$
  select net.http_post(
    url := 'https://ytkpthlhtbxtvtadepqt.supabase.co/functions/v1/sync-transactions',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || read_vault_secret('sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $job$
);

-- ---------------------------------------------------------------------------
-- Invite-only signup, without the dashboard toggle
-- ---------------------------------------------------------------------------
--
-- 0006 put the policy in hook_restrict_signup, which Supabase only calls once
-- the before-user-created hook is selected in project settings. Until then it
-- is inert and signup is open — a security control that is off by default and
-- depends on someone remembering to switch it on.
--
-- This enforces the same function as a trigger, so it is live the moment the
-- migration applies. The policy itself is not duplicated: the trigger calls
-- hook_restrict_signup and honours its verdict, so wiring up the official hook
-- later changes nothing about who is admitted.

create or replace function public.enforce_invite_only_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  verdict jsonb;
begin
  -- Escape hatch for deliberate admin work (restoring a user, seeding a test
  -- account): `set local app.bypass_signup_gate = 'on'` inside the transaction.
  -- Session-scoped, so it cannot be left on by accident from another request.
  if coalesce(current_setting('app.bypass_signup_gate', true), 'off') = 'on' then
    return new;
  end if;

  verdict := public.hook_restrict_signup(
    jsonb_build_object('user', jsonb_build_object('email', new.email))
  );

  if verdict ? 'error' then
    raise exception using
      errcode = 'insufficient_privilege',
      message = verdict -> 'error' ->> 'message';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_invite_only_signup on auth.users;
create trigger enforce_invite_only_signup
  before insert on auth.users
  for each row execute function public.enforce_invite_only_signup();
