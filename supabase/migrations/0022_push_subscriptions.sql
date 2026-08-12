-- Web push subscriptions, one row per device.
--
-- The service worker has handled `push` events since it was written, but
-- nothing ever sent one: no keys, nowhere to record who to send to, no
-- sender. This is the missing middle. A bill due Friday that the household
-- cannot cover is exactly the thing a budget app should say out loud before
-- it happens, and email at 09:30 UTC is not that.
--
-- A subscription is per browser, not per person: the same user on a phone and
-- a laptop is two rows, and revoking one must not silence the other. The
-- endpoint is the identity the push service itself uses, so it is the natural
-- primary key — re-subscribing on the same device updates rather than
-- duplicating.
--
-- The keys stored here are the subscription's own public key and auth secret.
-- They are useless without the VAPID private key (held in Vault), and they
-- encrypt only toward that one browser.
create table push_subscriptions (
  endpoint     text primary key,
  household_id uuid not null references households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_sent_at timestamptz,
  -- Set when a push service tells us the subscription is dead (404/410), so a
  -- device that has uninstalled the app stops being retried nightly.
  expired_at   timestamptz
);

create index on push_subscriptions (household_id) where expired_at is null;

alter table push_subscriptions enable row level security;

-- Household-scoped like everything else. A member can see that the household
-- has devices registered and can remove one; the keys are only ever used
-- server-side by the sender, which runs with the service role.
create policy push_subscription_access on push_subscriptions
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));

grant select, insert, update, delete on push_subscriptions to authenticated;
