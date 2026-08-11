-- Nightly LLM categorization of the residue keyword/PFC rules could not
-- place — see categorize-llm/index.ts for what "residue" means here and why.
--
-- 09:10 UTC: after daily-transaction-sync (09:00) has landed the day's new
-- rows, before daily-bill-sync (09:15) and daily-alert-email (09:30) run.

select cron.unschedule('daily-llm-categorize')
where exists (select 1 from cron.job where jobname = 'daily-llm-categorize');

select cron.schedule(
  'daily-llm-categorize',
  '10 9 * * *',
  $job$
  select net.http_post(
    url := 'https://ytkpthlhtbxtvtadepqt.supabase.co/functions/v1/categorize-llm',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || read_vault_secret('sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $job$
);
