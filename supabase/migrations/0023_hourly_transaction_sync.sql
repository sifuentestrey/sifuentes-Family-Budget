-- Keep the bank feed fresh enough for same-day paychecks and purchases.
--
-- The original 09:00 UTC daily job meant a paycheck that posted later in the
-- morning could be missing from the app until the next day. The live project
-- has already been corrected to hourly; this migration makes that behavior
-- reproducible from source instead of leaving production ahead of the repo.

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
