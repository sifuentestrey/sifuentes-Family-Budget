# Handoff — Family Budget

Paste this into a new chat to resume. Last updated 2026-08-14.

## Read this first

The previous version of this file said "no bank connected yet — `items` is
empty", and a whole session was spent telling the household to connect a bank
they had connected weeks earlier. **This file is a snapshot, not a live view.**
Before repeating any factual claim from it, check it — the queries at the
bottom take ten seconds.

## What this is

Household budget app for a two-person household with one variable-income
earner (call shifts, swings ~$1,400–$3,100/paycheck) and one stable
semi-monthly earner. Plaid for bank sync, Supabase for backend/auth, static
PWA frontend, deployed to GitHub Pages. Zero-cost stack by design.

- GitHub: `sifuentestrey/sifuentes-Family-Budget` (public)
- Supabase project: `ytkpthlhtbxtvtadepqt`
- Live app: https://sifuentestrey.github.io/sifuentes-Family-Budget/
- `main` is the only branch that matters. PRs #1–#19 merged.

## Current state

- **The bank is connected and syncing real transactions.** Real merchants,
  real amounts. The dashboard reads them — the old "dashboard always runs on
  the fixture" gap is closed; fixtures are the signed-out demo only.
- `npm test` — **359 passing, 0 failing**. `node_modules` is not checked in;
  a fresh clone needs `npm install` first (`unpdf` won't resolve otherwise).
- Service worker at **v26**. Bump `CACHE_VERSION` whenever a shell asset is
  added or returning users keep the old shell.
- **Verified 2026-08-12 against the live database**: 1 user, 1 household,
  **1 member**, **no invite ever sent**, 1 bank connection, **479
  transactions**, **6 tracked bills**, 0 budget targets.
- **The second person is still not in the household.** Everything shared —
  budget targets, bills, the plan — is running for one person. The invite
  path itself is complete and was read end to end:
  `create_household_invite(email)` issues one scoped to the caller's own
  household; `hook_restrict_signup` blocks signup by anyone without a live
  invite; and on first sign-in `bootstrap_household()` finds the pending
  invite matching that address, adds the user to **that** household, and
  marks the invite accepted. Nothing to build — it needs the email address.
- **Worth confirming in the dashboard**: the "Before user created" auth hook
  must be selected under Authentication → Hooks, or `hook_restrict_signup`
  is inert and signup is open to anyone. An uninvited signup would land in
  its own empty household rather than this one, so it is not a data-exposure
  risk, but it is an open door.

## The shape of the app now

Five tabs: **Home**, **Budget** (Budget / Bills), **Spending** (Overview /
Transactions), **Income** (Overview / Paycheck / Shifts / Paystubs), **More**.

- **Home** opens with money in the bank — the real account balance, checking
  and savings broken out — then a plain "free to spend until <payday>" line.
  The phrase "safe to spend" is gone; it was the app's own coinage.
- **Budget** is bills and necessities with targets. Targets default to the
  household's own trailing average and are stored per household in
  `budget_targets` (migration 0018), so both people plan against the same
  numbers.
- **Spending → Overview** splits the month into **bills** and **after the
  bills** (`src/engine/month-in-full.js`). Categories expand in place to the
  transactions inside them.
- **Design system is "Signal"** — soft grey ground, white cards lifted with a
  shadow, one dark hero card per screen, coral for "this wants you", green
  only for money coming in. `docs/ui/README.md` has the rules and the two
  layout traps (`<summary>` carries a negative margin from the normalize
  stylesheet; a nowrap title needs `min-width: 0`).

## Product north star — preserve this while extending the existing app

Do **not** rebuild the app around these notes. They are requirements to guide
future work on top of the current architecture and UI.

The app is for **both people in the household to view and control together**.
It should stay mobile-first, low-maintenance, automatic where possible, and
centered on actual household cash flow rather than traditional budgeting
complexity.

When future development gets scattered, return to four questions:

1. **What will the next paycheck actually be?**
2. **Which bills need to come out of that paycheck?**
3. **What is the household actually spending money on?**
4. **Was the variable-income paycheck paid correctly?**

Highest-value future capabilities, in roughly this order:

- **Bill-to-paycheck planning.** A bill should be assignable to a specific
  paycheck, ideally auto-assigned to the latest paycheck before its due date
  with a user override. A paycheck should show expected deposit, committed
  bills, and remaining/uncommitted money.
- **Paycheck forecasting.** Do not assume every paycheck is identical. The
  variable-income earner's pay can include regular hours, overtime, standby
  call, callback guarantees, evening differential, and night differential.
  Forecasts should eventually show estimated net deposit and a confidence
  level based on how complete/final the source timecard is.
- **Payroll audit.** The long-term audit path is department call schedule →
  UKG/Kronos timecard → paystub. Flag missing standby, callback, overtime,
  shift differential, minimum callback guarantees, wrong rates, or hours
  present upstream but absent from the paystub. The forecast and audit should
  share one versioned pay-rule model rather than duplicate calculations.
- **Food/restaurant awareness.** Keep merchant normalization and use the
  household's combined transactions to show restaurant, fast-food,
  delivery/coffee, and grocery spending by pay period and merchant. Inform;
  do not shame or turn this into spouse policing.
- **Variable utility forecasting.** Electricity and water should eventually
  use historical bills/usage and seasonality rather than a fixed monthly
  amount. Show a predicted amount/range and confidence. Weather, rate
  changes, and billing-cycle length are optional inputs when they materially
  improve accuracy.
- **Automatic ingestion first.** Prefer direct/API connectors, Plaid, email
  bill ingestion, and document extraction before asking for manual entry.
  Manual entry remains the fallback.

Pay rates are configuration/data, **not constants in source code**. Historical
examples from the household included roughly: base $52.72/hr, overtime
$79.08/hr, standby ~$8/hr, 2-hour callback minimum, evening differential
~$26/hr, and night differential ~$34/hr. These can change; any future payroll
model should version rates by effective date.

Do not turn the product into an envelope-budget system, spreadsheet clone,
generic Mint replacement, credit-score dashboard, or financial-advice bot.
Avoid requiring daily manual categorization and avoid making "safe to spend"
the product concept. The differentiator is **paycheck intelligence + bills
mapped to paychecks + automatic household spending awareness**.

## Things that are easy to get wrong here

- **Plaid's category is stored in `pfc_primary` / `pfc_detailed`** (migration
  0021). It used to be read at insert and thrown away, which silently
  disabled the plaid_pfc categorization layer server-side — everything
  downstream re-reads rows from the database, and the nested field is not a
  column. If a new field from Plaid matters, give it a column.
- **`reprocessWindow` (sync-transactions) is where categorization and
  transfer detection actually run**, over the last 30 days, on every sync.
  Insert-time values for category/transfer are not authoritative.
- **Merchant logos are curated, never guessed** (`merchant-domain.js`).
  Guessing a domain from a name produced parked domains and rows of generic
  globes, and first-word matching branded Del Taco as Taco Bell. Brand keys
  are six letters minimum and match the payee with separators stripped.
- **Categorization layers**, in precedence: learned → household rule → seed
  rule → plaid_pfc → similar (a lookalike payee, `similar-payee.js`) → llm →
  none. A human decision is never overwritten.

## Infrastructure (verified 2026-08-11, unchanged since)

- **Plaid is on `production`.** Free trial tier, up to 10 real bank
  connections. Diagnostic (no secrets echoed):
  `curl https://ytkpthlhtbxtvtadepqt.supabase.co/functions/v1/plaid-health`
- **Gmail bill-scanning OAuth is fully configured.** Google Cloud project
  `family-budget-505203`, consent screen in **Testing** status, test users
  `sifuentestrey@gmail.com` and `treysifuentes2@gmail.com`. Redirect URI is
  `https://ytkpthlhtbxtvtadepqt.supabase.co/functions/v1/gmail-oauth-callback`
  and must stay identical to `gmail-oauth-callback/index.ts`. Only listed
  test users can complete the flow; add more at
  console.cloud.google.com/auth/audience?project=family-budget-505203
- **Vault holds `sync_secret`**; three `pg_cron` jobs are active:
  `daily-transaction-sync` (09:00 UTC), `daily-bill-sync` (09:15),
  `daily-alert-email` (09:30). The nightly LLM categorizer runs from the same
  scheduling; `categorize-llm` also accepts a signed-in caller now, scoped to
  their own households.
- **CI deploys on merge to `main`**: `ci.yml` (tests), `pages.yml` (the app),
  `supabase.yml` (migrations + edge functions).

## Loose ends

1. **`SUPABASE_ACCESS_TOKEN` GitHub secret expires 2026-09-10.** Rotate at
   supabase.com/dashboard/account/tokens then `gh secret set
   SUPABASE_ACCESS_TOKEN --repo sifuentestrey/sifuentes-Family-Budget`, or
   Supabase deploys silently go back to no-op.
2. **~30 stale remote branches** (`payroll-v1`…`-v6`, `payroll-engine-*`,
   `x-pay`, etc.), almost all pointing at abandoned commit `4645f57`.
   Cosmetic; ask before bulk-deleting.
3. **Push notifications are wired in the service worker but nothing sends
   them** — no VAPID keys, no subscription table, no sender.
4. **No way to split a transaction** in the UI, though the schema supports it
   (`parent_transaction_id`, and the parent is excluded from totals).
5. **Everything is scoped to one month.** No year view.

## Verifying state quickly

```sql
-- project ytkpthlhtbxtvtadepqt, via Supabase MCP
select count(*) from auth.users;
select count(*) from items;                    -- bank connections
select count(*) from transactions;             -- real rows?
select count(*) from bills;                    -- tracked bills?
select count(*) from household_invites;        -- second member invited?
select count(*) from budget_targets;
select jobname, active from cron.job;
```

```bash
npm install && npm test          # expect 359 passing
curl -s https://sifuentestrey.github.io/sifuentes-Family-Budget/web/sw.js | grep CACHE_VERSION
git log --oneline -20            # this file is a snapshot; the log is the truth
```
