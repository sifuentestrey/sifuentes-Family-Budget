-- Outbound alert email: which alerts have already been sent, and the daily schedule.

-- ---------------------------------------------------------------------------
-- Sent-alert tracking
--
-- Mirrors the dismissal mechanism buildAlerts() already has for the in-app
-- banner (src/engine/alerts.js) — the same alert `key` scheme, just tracked
-- server-side so a bill due in 3 days doesn't generate a fresh email every
-- single day it remains true. A key change (due-soon -> overdue) is a new
-- row, and does email again, because that state genuinely is more urgent.
--
-- No RLS policies on purpose: only send-alerts touches this table, running as
-- the service role, which bypasses RLS entirely.
-- ---------------------------------------------------------------------------

create table sent_alerts (
  household_id  uuid not null references households(id) on delete cascade,
  alert_key     text not null,
  sent_at       timestamptz not null default now(),
  primary key (household_id, alert_key)
);

alter table sent_alerts enable row level security;

-- ---------------------------------------------------------------------------
-- Daily alert email
--
-- 09:30 UTC — after both daily-transaction-sync (09:00) and daily-bill-sync
-- (09:15), so the alerts it emails reflect the day's fresh sync rather than
-- yesterday's.
-- ---------------------------------------------------------------------------

select cron.unschedule('daily-alert-email')
where exists (select 1 from cron.job where jobname = 'daily-alert-email');

select cron.schedule(
  'daily-alert-email',
  '30 9 * * *',
  $job$
  select net.http_post(
    url := 'https://ytkpthlhtbxtvtadepqt.supabase.co/functions/v1/send-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || read_vault_secret('sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $job$
);
