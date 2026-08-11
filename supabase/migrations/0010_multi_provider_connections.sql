-- Allow more than one connection of the same provider per household.
--
-- Until now, provider_connections had unique(household_id, provider_key),
-- so a household could have exactly one Gmail connection. Connecting a
-- second Gmail account didn't add a second row — the upsert in
-- gmail-oauth-callback targeted the same (household_id, provider_key) pair,
-- so it silently overwrote the first connection's token and status.
--
-- external_account_id distinguishes multiple connections of the same
-- provider_key (the connected Gmail address, for 'gmail'). Defaults to ''
-- rather than being nullable so the unique constraint still enforces "at
-- most one" for any provider that never needs more than a single household-
-- wide connection — null would make every row distinct under a unique
-- index, silently defeating the constraint for those.

alter table provider_connections
  add column external_account_id text not null default '';

alter table provider_connections
  drop constraint provider_connections_household_id_provider_key_key;

alter table provider_connections
  add constraint provider_connections_household_id_provider_key_external_account_id_key
  unique (household_id, provider_key, external_account_id);
