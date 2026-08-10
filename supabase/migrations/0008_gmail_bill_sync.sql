-- Gmail bill sync: OAuth state tracking and the daily schedule.

-- ---------------------------------------------------------------------------
-- OAuth state
--
-- Google's redirect back to gmail-oauth-callback carries no Supabase session,
-- so a one-time state token is the only thing tying that request back to a
-- household. Rows are single-use (the callback deletes on read) and short-
-- lived (15 minutes, checked in the function) — this table only ever holds
-- flows that are currently in progress, so no cleanup job is needed at this
-- household's scale.
--
-- No RLS policies are defined on purpose: the only two callers are
-- gmail-oauth-start and gmail-oauth-callback, both running as the service
-- role, which bypasses RLS entirely. A browser has no business reading or
-- writing this table under any policy.
-- ---------------------------------------------------------------------------

create table oauth_states (
  state         text primary key,
  household_id  uuid not null references households(id) on delete cascade,
  provider_key  text not null,
  created_at    timestamptz not null default now()
);

alter table oauth_states enable row level security;

-- ---------------------------------------------------------------------------
-- Daily bill sync
--
-- 09:15 UTC — 15 minutes after daily-transaction-sync, so the two jobs don't
-- compete for the same window. There's no data dependency between them; this
-- just keeps them from landing in the same minute.
-- ---------------------------------------------------------------------------

select cron.unschedule('daily-bill-sync')
where exists (select 1 from cron.job where jobname = 'daily-bill-sync');

select cron.schedule(
  'daily-bill-sync',
  '15 9 * * *',
  $job$
  select net.http_post(
    url := 'https://ytkpthlhtbxtvtadepqt.supabase.co/functions/v1/sync-bills',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || read_vault_secret('sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $job$
);
