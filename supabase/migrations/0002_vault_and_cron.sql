-- Token storage and the daily sync schedule.

create extension if not exists supabase_vault with schema vault;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Plaid access tokens live in Vault, never in a table column.
--
-- A token in an ordinary column ends up in every database backup, every
-- `select *`, and any PostgREST response that forgot to exclude it. Vault keeps
-- it encrypted at rest and reachable only through these SECURITY DEFINER
-- functions, which are granted to the service role alone.
-- ---------------------------------------------------------------------------

create or replace function read_vault_secret(secret_name text)
returns text
language plpgsql
security definer
set search_path = vault, public
as $$
declare
  result text;
begin
  select decrypted_secret into result
  from vault.decrypted_secrets
  where name = secret_name;

  if result is null then
    raise exception 'secret % not found', secret_name;
  end if;

  return result;
end;
$$;

create or replace function store_vault_secret(secret_name text, secret_value text)
returns void
language plpgsql
security definer
set search_path = vault, public
as $$
begin
  -- Re-storing under the same name replaces, so a re-auth overwrites cleanly
  -- rather than leaving a stale token behind.
  delete from vault.secrets where name = secret_name;
  perform vault.create_secret(secret_value, secret_name, 'Plaid access token');
end;
$$;

-- Anon and authenticated roles must never reach these. Only the service role,
-- which is exclusively used server-side by the sync function.
revoke all on function read_vault_secret(text) from public, anon, authenticated;
revoke all on function store_vault_secret(text, text) from public, anon, authenticated;
grant execute on function read_vault_secret(text) to service_role;
grant execute on function store_vault_secret(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Daily sync.
--
-- Plaid refreshes institution data roughly once a day, so syncing more often
-- burns quota for no new data. 09:00 UTC lands early morning US, after
-- overnight posting has settled.
--
-- Side benefit worth knowing: Supabase pauses free-tier projects after ~7 days
-- of inactivity. A daily cron keeps the project awake.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'daily-transaction-sync',
  '0 9 * * *',
  $$
  select net.http_post(
    url := current_setting('app.settings.sync_function_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.sync_secret')
    ),
    timeout_milliseconds := 120000
  );
  $$
);

-- ---------------------------------------------------------------------------
-- Sync health.
--
-- Silent sync failure is the main way a tool like this quietly becomes wrong:
-- the dashboard keeps rendering last week's numbers and looks perfectly fine.
-- The UI reads this view and shows staleness prominently.
-- ---------------------------------------------------------------------------

create view sync_health as
select
  i.household_id,
  i.id as item_id,
  i.institution_name,
  i.status,
  i.status_detail,
  (
    select max(finished_at)
    from sync_log l
    where l.item_id = i.id and l.status = 'success'
  ) as last_success,
  (
    select count(*)
    from sync_log l
    where l.item_id = i.id
      and l.status = 'error'
      and l.started_at > now() - interval '3 days'
  ) as recent_failures
from items i;
