-- Finance Brain application audit. Only safe, reversible app-internal changes are eligible
-- for automatic application; everything else remains advisory/review-only.

alter type public.categorized_by add value if not exists 'finance';

create table if not exists public.finance_brain_actions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  recommendation_id text not null,
  action_index integer not null default 0,
  operation text not null check (operation in ('set_transaction_transfer','set_transaction_category')),
  target_key text not null,
  proposed jsonb not null default '{}'::jsonb,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  status text not null default 'pending' check (status in ('pending','applied','review','rejected','failed')),
  reason text,
  before_state jsonb,
  after_state jsonb,
  error text,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  unique (household_id, recommendation_id, action_index)
);

alter table public.finance_brain_actions enable row level security;

create policy "household members can read finance brain actions"
on public.finance_brain_actions for select
to authenticated
using (exists (
  select 1 from public.household_members hm
  where hm.household_id = finance_brain_actions.household_id
    and hm.user_id = (select auth.uid())
));

create index if not exists finance_brain_actions_household_created_idx
  on public.finance_brain_actions (household_id, created_at desc);
