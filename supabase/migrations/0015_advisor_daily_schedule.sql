-- Daily advisor check-in, scheduled after every other morning job has landed:
-- daily-transaction-sync (09:00), daily-llm-categorize (09:10),
-- daily-bill-sync (09:15), daily-alert-email (09:30). 09:40 UTC so the note
-- reflects the day's fully processed data rather than racing it.

select cron.unschedule('daily-advisor-checkin')
where exists (select 1 from cron.job where jobname = 'daily-advisor-checkin');

select cron.schedule(
  'daily-advisor-checkin',
  '40 9 * * *',
  $job$
  select net.http_post(
    url := 'https://ytkpthlhtbxtvtadepqt.supabase.co/functions/v1/advisor-daily',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || read_vault_secret('sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $job$
);
