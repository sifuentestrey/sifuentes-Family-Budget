-- Reconcile production sync scheduling with source and remove the temporary
-- micro-income cleanup band-aid.
--
-- 0023 documents the hourly transaction schedule, but production received that
-- change as a hot-fix while GitHub Actions was missing SUPABASE_DB_PASSWORD.
-- Repeating the schedule here is intentional and idempotent: a clean database
-- gets the same result, and the current database gets a tracked migration that
-- brings it back under source control.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('daily-transaction-sync')
where exists (select 1 from cron.job where jobname = 'daily-transaction-sync');

select cron.schedule(
  'daily-transaction-sync',
  '0 * * * *',
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

-- This job was added directly in production while debugging a false $4-$8
-- "payroll" stream. The real fix now lives in income.js plus the longer server
-- reprocess window. Keeping this SQL workaround would erase legitimate small
-- inflows from the semantic income flag and would drift from source forever.
select cron.unschedule('cleanup-false-income-streams')
where exists (select 1 from cron.job where jobname = 'cleanup-false-income-streams');

-- A function timeout can leave an audit row in "running" even though later
-- jobs complete normally. Close historical abandoned rows once; both sync Edge
-- Functions now also self-heal these on future runs.
update sync_runs
set status = 'error',
    completed_at = coalesce(completed_at, now()),
    errors = case
      when jsonb_array_length(errors) = 0 then
        jsonb_build_array(jsonb_build_object(
          'stage', 'sync',
          'message', 'Previous sync ended without completion; closed during sync-health reconciliation.'
        ))
      else errors
    end
where status = 'running'
  and started_at < now() - interval '90 minutes';

update sync_log
set status = 'error',
    finished_at = coalesce(finished_at, now()),
    error_message = coalesce(error_message, 'Previous sync ended without completion; closed during sync-health reconciliation.')
where status = 'running'
  and started_at < now() - interval '90 minutes';
