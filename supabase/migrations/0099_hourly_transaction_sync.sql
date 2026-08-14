-- Transaction freshness matters for paycheck-day planning. A single 09:00 UTC
-- pull can miss deposits that post later in the morning, leaving the dashboard
-- stale until the following day. Pull Plaid deltas hourly instead.
select cron.alter_job(1, schedule := '0 * * * *');
