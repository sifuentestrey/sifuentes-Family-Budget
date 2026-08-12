-- Keep Plaid's own category on the row.
--
-- It was being read once, at insert, and then discarded — the two fields are
-- not columns, so the upsert dropped them. Everything downstream runs in
-- reprocessWindow, which re-reads the rows from this table, so from its point
-- of view Plaid never had an opinion at all:
--
--   * the plaid_pfc categorization layer, third in precedence, never fired
--     server-side. Rows it should have decided fell through to the LLM or to
--     the review queue instead.
--   * transfers Plaid explicitly labels TRANSFER_OUT — money moved to a
--     brokerage or a retirement account — could not be recognised, so they
--     counted as spending and were then given whatever category guessed
--     hardest. The one that surfaced this was a Fidelity transfer filed under
--     Dining Out.
--
-- Two nullable text columns. Nothing is backfilled: Plaid's category arrives
-- with the transaction, so history fills in as the sync re-fetches it.
alter table transactions add column if not exists pfc_primary text;
alter table transactions add column if not exists pfc_detailed text;
