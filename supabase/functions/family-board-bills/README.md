# Family Board bill bridge

The existing Family Board reads bill summaries and appends checklist choices through this server connection. No Budget login is required on the Board.

The handler authenticates a separate 256-bit key before reading financial data. Vercel stores the plaintext key only in its server environment; `family_board_private.bill_bridge` stores its SHA-256 hash and verified household/member. A service-only SECURITY INVOKER RPC reads that configuration. There is no client-selected household. Removing the configured household membership removes the connection. The function's built-in service credential remains inside Supabase.

The allowed operations are `read` for a bill month and `append` for a validated tracker event. Bank transactions are read only. Responses include computed bill status and payments from the configured bill providers, excluding general transaction history, raw bank descriptions, Plaid IDs, account balances and credentials. Corrections append new tracker events with the configured member as author and server-assigned creation time. Clear matches retain a deterministic ID per transaction to prevent reuse and duplicate writes.

`verify_jwt=false` is required because the caller uses the scoped key rather than a user JWT. The handler rejects missing, wrong and disabled keys. Do not remove its custom authentication.

The `.mjs` modules are deployed copies of the same modules tested in the Family Board repository (`lib/smart-bills.mjs`, `lib/server-bill-store.mjs`, `lib/bill-board-bridge.mjs`). When changing them, keep those sources aligned and run `test/bill-board-bridge.test.mjs`, `test/bill-bridge-schema.test.mjs` and the monthly bill and UI suites there.
