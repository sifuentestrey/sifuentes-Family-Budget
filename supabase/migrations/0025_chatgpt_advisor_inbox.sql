-- ChatGPT Finance advisor delivery inbox.
-- Idempotency is enforced by one unique recommendation_id per household.

create table advisor_recommendations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  recommendation_id text not null,
  analysis_date date not null,
  type text not null,
  action text not null check (action in ('apply','review','flag_only','no_action','already_applied')),
  priority text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  title text not null,
  message text not null,
  reason text,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','applied','dismissed','duplicate')),
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  unique (household_id, recommendation_id)
);

create index advisor_recommendations_household_created
  on advisor_recommendations (household_id, created_at desc);

alter table advisor_recommendations enable row level security;

create policy advisor_recommendation_access on advisor_recommendations
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));
