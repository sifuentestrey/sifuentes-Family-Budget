# Handoff — Family Budget

Paste this into a new chat to resume. Written 2026-08-10.

## What this is

Household budget app for a two-person household with one variable-income
earner (call shifts, swings ~$1,400–$3,100/paycheck) and one stable
semi-monthly earner. Plaid for bank sync, Supabase for backend/auth, static
PWA frontend, deployed to GitHub Pages. Zero-cost stack by design.

## Repo / project IDs

- GitHub: `sifuentestrey/sifuentes-Family-Budget` (now **public**)
- Supabase project: `ytkpthlhtbxtvtadepqt`
- Live app: https://sifuentestrey.github.io/sifuentes-Family-Budget/
- Working branch: `claude/family-budget-shared-accounts-djv89t` — PR #2 open
  (title: "Invite-only signup, and shift logging with paycheck forecast"),
  draft, CI green, no review comments as of last check.

## Current state (verified, not assumed)

- **211 tests passing**, all offline against fixtures.
- **`auth.users` is empty** — nobody has signed up yet, including the owner.
- **PLAID_ENV is `sandbox`**, not production. Credentials otherwise valid
  (whitespace-trimmed at point of use).
- **Repo is public.** Confirmed clean before flipping: no secrets, only
  synthetic fixture data (`fixtures/sample-plaid.json` is explicitly labeled
  invented), real data paths are gitignored.
- **Signup is invite-gated at the database level**, enforced two ways so it
  doesn't depend on a dashboard click: a `before-user-created` auth hook
  (`hook_restrict_signup`) AND a trigger on `auth.users`
  (`enforce_invite_only_signup`) that calls the same function. First account
  ever is admitted unconditionally (bootstraps the household), everyone after
  needs a pending invite. Verified live: stranger refused (403), invited
  address (case/whitespace-insensitive) admitted, expired/consumed invites
  refused, joining an invite consumes it and adds to the *existing* household
  rather than creating a new one.
- **Daily sync is scheduled** — `pg_cron` job `daily-transaction-sync`,
  09:00 UTC, calls `sync-transactions` with a bearer token now stored in
  Supabase Vault (`sync_secret`). Confirmed active in `cron.job`.
- **A real auth bug was found and fixed**: `sync-transactions` compared the
  bearer token against a template string with an unset env var
  (`SYNC_SECRET`), so the effective check was against the literal string
  `"Bearer undefined"` — verified live, it returned HTTP 200. Fixed to read
  from Vault, fail closed if unconfigured, constant-time compare. Regression
  tests added and confirmed to fail when the pattern is reintroduced.
  **This fix is committed but not yet deployed** (see Blockers).
- **Shift logging is built**: pay profile setup + per-shift entry + paycheck
  forecast, wired into a new "Shifts" nav tab. Uses the existing (already
  tested) payroll engine in `src/payroll/`. DB column mapping extracted to
  `src/payroll/mapping.js` specifically so it's unit-testable (the browser
  module that queries Supabase can't be loaded by the test runner).
- **CI/CD for Supabase added**: `.github/workflows/supabase.yml` deploys edge
  functions + migrations from disk on merge to `main`, gated on
  `SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_PASSWORD` secrets existing (skips
  with a warning if not, doesn't fail red).
- Codex pushed 5 additive files directly to `main` (provider readiness
  service, docs) — merged into this branch, no conflicts.

## Blockers — things that need you, specifically

1. **Add `SUPABASE_ACCESS_TOKEN` as a GitHub repo secret**
   (from https://supabase.com/dashboard/account/tokens). This is what
   deploys the sync-secret fix and everything else in `supabase/`. Until
   it's set, the CI Supabase workflow skips itself — the auth bug fix sits
   committed but not live on the deployed function.
   Optional: also add `SUPABASE_DB_PASSWORD` to let CI push migrations too
   (migrations are currently applied by me via MCP tool, which still works,
   just isn't automated end-to-end without this).

2. **Merge PR #2** once you're satisfied — or ask the new session to check
   status/merge it. Nothing is blocking it; it was green last checked.

3. **Sign up in the app** — you're user #0, so you're admitted
   unconditionally. This is what creates the household.

4. **Connect a bank.** Recommended order: sandbox first (proves the sync
   pipeline end-to-end — it's never run against real Plaid, not once), then
   flip `PLAID_ENV` to `production` and connect real accounts.

5. **Invite your wife** from the Connect tab once you have an account —
   she needs a pending invite to sign up at all now.

## Deliberately not done yet

- Paystub reconciliation UI (engine exists, tested, not wired to a view) —
  this is what would let the app learn your real effective tax rate instead
  of the guessed rate you enter in pay setup. Natural next step after shift
  logging.
- Email bill ingestion (lower priority than shifts — reasoning: Plaid
  transaction data already derives most of what bills would show; shifts are
  the one thing Plaid structurally cannot know in advance).
- No email/push delivery for alerts — in-app only, no mail provider
  configured.

## How to verify state quickly in a new session

```sql
-- against project ytkpthlhtbxtvtadepqt via Supabase MCP tools
select count(*) from auth.users;                    -- should be 0 until you sign up
select jobname, active from cron.job;                -- daily-transaction-sync, active=true
select count(*) from vault.secrets where name='sync_secret';  -- 1
```

```bash
git fetch origin && git log --oneline origin/claude/family-budget-shared-accounts-djv89t -5
npm test 2>&1 | tail -5   # expect 211+ passing
```

## Tone/process notes for the next session

- User wants **all automation, nothing manual unless ABSOLUTELY necessary**
  — the CI workflow and DB-level enforcement above are direct responses to
  that. Keep defaulting that direction; ask before adding a manual step.
- I do NOT have a Supabase management/CLI token in this environment — only
  the MCP tool (`execute_sql`, `apply_migration`, `deploy_edge_function`
  which requires pasting full file contents inline). That's *why* the CI
  workflow exists — pasting ~60KB of engine code by hand for every function
  deploy was the wrong mechanism. Don't revert to hand-pasting once the CI
  token is set.
- This repo is **public**. Before adding anything, sanity-check it's not
  real financial data (`.gitignore` already blocks `data/*`, `*.csv`, etc. —
  don't weaken that).
