# Architecture

Developer reference for the Family Budget application.

## What is real and what is not

This distinction is load-bearing and appears throughout the code as
`ProviderInfo.isLive`.

| Capability | Status |
|---|---|
| Bank transaction sync (Plaid) | **Integration code written, never run against live Plaid.** No Plaid account exists. Untested end to end. |
| Bill ingestion from email | **Adapter interface + mock only.** No mail provider is connected. |
| Payroll / timecard import | **Adapter interface + mock only.** No timekeeping system is connected. |
| Paystub import | **Adapter interface + mock only.** |
| Categorization, transfers, income modeling | Real, tested offline against synthetic fixtures. |
| Pay calculation, forecast, reconciliation | Real, tested offline. |
| Bill parsing, dedupe | Real, tested against fixture emails. |
| Safe-to-spend, budget integration | Real, tested offline. |
| Database schema + RLS | Applied to Supabase project `ytkpthlhtbxtvtadepqt`. |

Nothing in the UI may describe a mock as connected. `registry.liveConnected()`
and `registry.hasLiveProvider()` exist specifically so the interface can tell
the truth without each screen re-deriving it.

## Layout

```
src/
  domain/         models + validation (bill.js, payroll.js)
  providers/      adapter contracts, registry, mock implementations
  ingestion/      bill parsing, date parsing, dedupe, email ingestion
  payroll/        pay calculation, forecast, reconciliation
  budget/         safe-to-spend
  sync/           sync engine + run recording
  engine/         pre-existing: categorization, transfers, income, expenses,
                  allocation, guidance, subscriptions, alerts
supabase/
  migrations/     0001 core, 0002 vault+cron, 0003 bills+payroll, 0004 view security
  functions/      Edge Functions (Deno)
web/              PWA — no build step
tests/            node:test, all offline
docs/
```

Engine modules are pure functions with no database or network dependency. That
is why the whole system is testable without credentials, and why the same code
runs in the browser and in a Deno Edge Function.

## Data flow

### Bills

```
EmailProvider / BillProvider          ← adapter, swappable
        ↓
classifyMessage()                     ← is this a bill, a receipt, or marketing?
        ↓
parseBillText()                       ← generic bill language, not per-company templates
        ↓
makeBill() + validateBill()           ← normalized Bill, confidence scored
        ↓
partitionBills()                      ← duplicate detection, three tiers
        ↓
bills table                           ← unique constraints as the real backstop
        ↓
safe-to-spend / budget
```

### Payroll

```
PayrollProvider.getTimecard()
        ↓
TimeEntry[]
        ↓
calculatePay()                        ← OT rules, callback minimums, standby
        ↓
forecastPaycheck()                    ← + confidence from period coverage
        ↓
budget

PayrollProvider.getPaystubs()
        ↓
reconcilePaycheck()                   ← expected vs actual
        ↓
learnFromHistory()                    ← median across ≥3 stubs
        ↓
applyLearnedAdjustments()             ← never automatic; caller decides
```

## Domain models

### Bill (`src/domain/bill.js`)

Normalized output of every ingestion path. Key fields beyond the obvious:

- `confidence` (0–1). Below `REVIEW_THRESHOLD` (0.7) a bill is surfaced for
  confirmation instead of silently budgeted against.
- `source` / `sourceMessageId` / `sourceDocumentId` — provenance, and the basis
  for the strongest duplicate check.
- `accountLabel` — **last 4 only**. `validateBill` rejects anything that looks
  like a full account number, and the database caps the column at 8 characters.
- `providerKey` — stable slug used for matching across channels.

### TimeEntry / PayProfile / Paystub (`src/domain/payroll.js`)

`PayProfile` carries the two settings that decide whether a forecast is right:

- `dailyOvertimeThreshold` — **defaults to 0 (disabled)**. An 8-hour daily rule
  turns every 10-hour shift on a 4x10 schedule into 2 hours of overtime, about
  8 phantom hours a week.
- `callbackMinimumHours` — a contractual minimum paid per callback event
  regardless of time worked. Two 30-minute callouts on a 2-hour minimum pay
  4 hours, not 1.

`standbyHours` is time on call, not worked. It never counts toward overtime and
is excluded from the 24-hour daily worked-hours check.

## Provider adapter pattern

Adapters are plain objects implementing a contract in
`src/providers/types.js`. There is no base class to extend.

```js
const provider = {
  info: {
    key: 'gmail',
    displayName: 'Gmail',
    kind: 'email',
    isLive: true,            // never lie about this
    authType: 'oauth2',
  },
  async isConnected() { /* … */ },
  async searchMessages(query) { /* … */ },
  async getMessage(id) { /* … */ },
};

registry.register(provider);   // throws if the contract is unmet
```

`validateProvider()` runs at registration, not at call time — a missing method
should fail visibly rather than as absent bills three weeks later.

### Adding a bill provider

1. Create `src/providers/<name>.js` exporting a factory returning a `BillProvider`
   (or an `EmailProvider` if bills arrive as mail).
2. Implement `isConnected()` and `getBills()` (or the email trio).
3. Set `info.isLive = true` **only when it genuinely contacts the service**.
4. Register it. Nothing else changes — the sync engine, parsers, dedupe, and
   budget are all provider-agnostic.
5. If the provider's format needs special handling, post-process the output of
   `parseBillText()` inside the adapter. Do not add company-specific logic to
   the parser.

### Adding a payroll provider

Same shape, implementing `getTimecard(period)` and `getPaystubs({since})`,
returning domain `TimeEntry[]` / `Paystub[]`. Set `sourceRef` on every record —
it is the strongest dedupe signal available.

## Bill parsing

`parseBillText()` matches the language bills actually use, ranked by how likely
each label is to be the figure owed:

```
total amount due (1.0) > amount due (0.98) > balance due (0.92)
  > current charges (0.82) > minimum payment (0.75) > total (0.5)
```

Labels that mean the opposite — `previous balance`, `payment received`, `credit`
— exclude the number that follows them. The lookback is scoped to the current
line: a fixed character window reaches into the row above, where
"Payment Received -$186.44" sits directly over "Total Amount Due $203.17", and
made every itemized statement discard its own total.

Dates are handled in `date-parser.js`. Two hazards:

- **Ambiguous numeric dates.** `03/04/2026` is March 4 in the US and April 3
  elsewhere. Locale is an explicit parameter; ambiguous parses lose 0.25
  confidence, which drops them below the review threshold.
- **Missing years.** "Due January 5" on a December statement means *next*
  January. The year is chosen as the nearest plausible date to the statement
  date rather than defaulting to the current year.

## Duplicate detection

Duplicates are the normal consequence of automation, not an edge case: one bill
arrives as an email, a PDF, an API record, and again on every overlapping
re-sync. Three tiers in `src/ingestion/dedupe.js`:

1. **Source** — same message/document id. Certain.
2. **Identity** — same household, provider, due date, amount.
3. **Fuzzy** — same provider, amount within 1%, due dates within 3 days.
   Reported rather than merged silently.

A duplicate can still *improve* the stored record: `shouldUpdateExisting()`
ranks sources (`manual > provider_api > pdf > provider_portal > email`) and
never overwrites a manual entry or a paid bill.

**Application-level dedupe is not sufficient.** Concurrent syncs defeat it. The
unique indexes in migration 0003 are the real backstop:

- `bills_identity_key (household_id, provider_key, due_date, amount_due)`
- `bills_source_message_key (household_id, source, source_message_id)`
- `paystubs_identity_key`, `paystubs_source_ref_key`
- `time_entries_profile_date_key (pay_profile_id, entry_date)`

## Sync system

`syncBills()`, `syncPayroll()`, `syncPaystubs()` in `src/sync/sync-engine.js`.
Each records a `SyncRun`: `startedAt`, `completedAt`, `provider`, `status`,
`itemsFound/Created/Updated/Skipped`, `duplicatesDetected`, `errors`,
`providerIsLive`, `durationMs`.

Storage is injected (`SyncStore`), so the engine runs identically against
Postgres or the in-memory store used in tests.

`summarizeSyncState()` produces the "Electricity — 12 minutes ago" view and
flags anything not synced within 26 hours as stale. It reports `liveProviders`
and `mockProviders` separately so the UI cannot imply data is flowing from
fixtures.

## Safe-to-spend

`src/budget/safe-to-spend.js`. Deliberately **not** balance minus bills, which:

- ignores pending transactions (money already spent counted as available),
- ignores ordinary variable spending after the next bill,
- treats savings goals and the emergency buffer as spendable,
- assumes an average paycheck, which for variable income is wrong about half
  the time.

The result is a starting point followed by named, explained deductions:
pending, bills due before payday, groceries/fuel prorated by day, sinking-fund
contribution, savings goals, and the emergency buffer shortfall. Every entry
carries a `note`, because an opaque number gets ignored.

Horizon is **until the next payday**, not a calendar month — that is the
interval the household must actually survive on the money in hand.

## Security model

- **No passwords for utility or payroll sites, ever.** OAuth or official APIs
  only. A provider requiring a scraped login is not implemented rather than
  implemented insecurely.
- **Secrets live in Supabase Vault**, referenced by name (`token_ref`). A token
  in an ordinary column appears in every backup and every `select *`.
- **Nothing sensitive reaches the browser.** A test fails the build if anything
  under `web/` references a service-role key or an access token.
- **RLS on every table**, scoped through `current_household_ids()`.
- **Views must set `security_invoker = true`.** A view executes as its owner by
  default, which bypasses RLS entirely — the tables stay protected while the
  view hands out every household's rows. This was a real defect caught by the
  Supabase advisor after 0003; migration 0004 fixes it and a test prevents
  regression.
- **`current_household_ids()` is revoked from PUBLIC.** `anon` inherits EXECUTE
  from PUBLIC, so revoking from `anon` alone is a no-op. `authenticated` must
  keep it: policy expressions evaluate as the querying role, so removing it
  breaks every policy.
- **Account numbers are truncated to last-4** at parse time, at validation, and
  by a database check constraint.
- **Financial identifiers are never logged.** Parser provenance goes in
  `bills.raw` for debugging and is not rendered to users.

## Environment variables

Server-side only. Never in the repo; `.env` is gitignored and `.env.example`
documents the shape.

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side only. Bypasses RLS — never ship to a browser. |
| `SUPABASE_ANON_KEY` | Browser-safe; RLS restricts it to the signed-in household. |
| `PLAID_CLIENT_ID` | Plaid |
| `PLAID_SECRET` | Plaid |
| `PLAID_ENV` | `sandbox` \| `production` |
| `SYNC_SECRET` | Shared secret the cron job presents to the sync function |

Not yet used, required when the corresponding integration is built:

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail OAuth |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | Outlook OAuth |
| `RESEND_API_KEY` | Outbound alert email |

## Testing

```bash
npm test          # 188 tests, fully offline
npm run plan      # engine output against synthetic fixtures
npm run demo      # transaction pipeline output
```

Everything runs without credentials or network. Fixtures deliberately include
the cases that break naive implementations: a payment receipt that parses as a
bill, an ambiguous date, a statement with five dollar figures, a duplicate
arriving through a second channel, a 4x10 week, a 30-minute callback, and a
three-paycheck month.

## Known gaps

- No live provider of any kind is connected.
- Plaid integration code has never been exercised against the real API.
- `pg_cron` scheduling (migration 0002) is not applied — it was written before
  the Vault functions existed and depends on them.
- PDF parsing has an interface (`DocumentParser`) but no implementation; there
  is no PDF text-extraction dependency in the project.
- The dashboard does not yet render bills, paycheck forecasts, or sync status.
