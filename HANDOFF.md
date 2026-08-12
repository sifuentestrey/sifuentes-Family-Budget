# Handoff — Family Budget

Paste this into a new chat to resume. Last updated 2026-08-11 (evening —
supersedes the afternoon version of the same date, which superseded the
morning one; everything described in those has merged to `main`).

## Newest work (2026-08-11 evening)

- **The UI was rebuilt on one design system.** `web/index.html`'s stylesheet
  is now tokens plus a fixed set of components (`.hero`, `.card`, `.row`,
  `.kv`, `.chip`, `.btn`, `.field`, `.empty`, `.seg`), and every view composes
  those instead of its own inline styles. Before this, each screen had its own
  row shape and its own button styling, which is why the app read as several
  apps stapled together. `docs/ui/README.md` documents the components and the
  navigation model — read it before adding a screen.
- **Navigation changed shape.** Still five tabs, but Spending and Income now
  carry segmented controls for their sibling views (Overview / Transactions /
  Recurring / Trends, and Overview / Paycheck / Shifts / Paystubs). "More" is
  down to settings-ish destinations. Two tests in `tests/shifts.test.mjs`
  guard both directions: every navigable id has a renderer, and every renderer
  is reachable from the nav.
- **Bills can now be added from transactions.** New pure module
  `src/engine/bill-suggestions.js` (18 tests) proposes bills from recurring
  charges already in the household's own transactions — the "Found in your
  transactions" section on Bills, with one-tap Track as bill / Not a bill.
  Nothing is saved without a tap. Accepted bills are `source: 'bank'`, a new
  value on the `bill_source_type` enum — **migration `0017_bill_source_bank.sql`
  is already applied to the live database** (verified), so the repo file is a
  record, not a pending change.
- Dismissed suggestions live in `localStorage` under
  `dismissedBillSuggestions`, deliberately not in the database.
- Service worker is at `v17`; `npm test` is **311 passing, 0 failing**.

## What this is

Household budget app for a two-person household with one variable-income
earner (call shifts, swings ~$1,400–$3,100/paycheck) and one stable
semi-monthly earner. Plaid for bank sync, Supabase for backend/auth, static
PWA frontend, deployed to GitHub Pages. Zero-cost stack by design.

## Repo / project IDs

- GitHub: `sifuentestrey/sifuentes-Family-Budget` (public)
- Supabase project: `ytkpthlhtbxtvtadepqt`
- Live app: https://sifuentestrey.github.io/sifuentes-Family-Budget/
- `main` is the only branch that matters. PRs #1–#9 are all merged, 0 open.
  The old working branch `claude/family-budget-shared-accounts-djv89t` is
  fully superseded (everything on it is in `main`, some of it evolved
  further) — safe to delete, nobody has done so yet.

## Current state (verified 2026-08-11 against live Supabase + local repo)

- **311 tests passing** (`npm test`), 0 failing. Note: `node_modules` is not
  checked in — a fresh clone/machine needs `npm install` before tests will
  run (the `unpdf` dependency fails to resolve otherwise).
- **1 user in `auth.users`** — the owner has signed up. Household exists.
- **No bank connected yet** — `items` table is empty. This needs the owner,
  in-app, with real bank credentials; not something an agent can or should
  do.
- **No invites sent yet** — `household_invites` is empty. Needs the second
  household member's email, which only the owner has.
- **Plaid is now on `production`, not `sandbox`.** Confirmed live via the
  `plaid-health` edge function (unauthenticated diagnostic endpoint, reports
  presence/shape only, never echoes secrets:
  `curl https://ytkpthlhtbxtvtadepqt.supabase.co/functions/v1/plaid-health`).
  The account is on Plaid's free trial tier — real production API access for
  up to 10 real bank connections, no manual Plaid approval process needed
  (0/10 used as of this writing). `PLAID_CLIENT_ID` is unchanged (shared
  across Plaid environments); `PLAID_SECRET` was replaced with the
  production secret from the Plaid dashboard's Keys page.
- **Gmail bill-scanning OAuth is now fully configured**, not just coded.
  Previously `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` were unset entirely —
  `gmail-oauth-start` would 503 immediately. Set up end-to-end this session:
  - Google Cloud project `family-budget-505203` (already existed, pre-dates
    this session — unclear which prior session created it) now has an OAuth
    consent screen: External audience, Testing publishing status (no Google
    verification needed at this scale), app name "Family Budget", test users
    `sifuentestrey@gmail.com` and `treysifuentes2@gmail.com`.
  - OAuth 2.0 Client ID "Family Budget Gmail sync" (Web application type)
    created with redirect URI
    `https://ytkpthlhtbxtvtadepqt.supabase.co/functions/v1/gmail-oauth-callback`
    (matches `gmail-oauth-callback/index.ts` exactly — this must stay in
    sync if that function's URL ever changes).
  - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` set as Supabase secrets via
    the Supabase CLI (see below), values taken directly from Google's
    one-time credential-reveal dialog, not retyped from a screenshot.
  - **Testing-mode caveat**: only the two test-user emails above can
    complete the Gmail OAuth flow. Adding a third household member's Gmail
    for bill-scanning means adding them as a test user first at
    console.cloud.google.com/auth/audience?project=family-budget-505203
    (100 test-user cap, refreshed only by full Google app verification,
    which is a bigger undertaking — not needed at household scale).
- **The sync-transactions auth bug fix IS deployed and live**, not just
  committed — confirmed by reading the deployed function body directly via
  Supabase MCP (`get_edge_function`), not just checking git. It reads the
  bearer secret from Vault, fails closed if unset, constant-time compares.
- **Vault has `sync_secret`** (1 row), and three `pg_cron` jobs are active:
  `daily-transaction-sync` (09:00 UTC), `daily-bill-sync` (09:15 UTC),
  `daily-alert-email` (09:30 UTC).
- **The GitHub Actions Supabase-deploy workflow (`supabase.yml`) now
  actually works.** `SUPABASE_ACCESS_TOKEN` was never set — every run before
  this session (4 runs, ~10s each) hit the "not set — skipping deploy"
  branch and exited green without doing anything. Fixed this session: a
  Supabase personal access token ("github-actions-deploy", expires
  2026-09-10 — Supabase's token dialog offered no non-expiring option this
  time, unlike the pre-existing "Migration" token which shows "Never") is
  now set as the `SUPABASE_ACCESS_TOKEN` repo secret via `gh secret set`.
  **Whoever picks this up before 2026-09-10 should rotate it** (same steps:
  supabase.com/dashboard/account/tokens → generate → `gh secret set
  SUPABASE_ACCESS_TOKEN --repo sifuentestrey/sifuentes-Family-Budget`) or CI
  silently reverts to no-op mode again.
- Shift logging, invite-only signup, Gmail bill scanning, PDF paystub
  attachments, outbound alert emails, paystub reconciliation, and
  Safe-to-Spend-as-the-authoritative-dashboard-number are all built, tested,
  and merged (PRs #2, #4, #6, #7, #8, #9).
- **The main dashboard still runs entirely on synthetic demo data,
  regardless of bank-connection state.** This is a real, confirmed gap, not
  a misconfiguration — traced through `web/app.js`: `state.transactions` is
  set exactly once, in `load()`, always from `fixtures/sample-plaid.json`,
  with zero code path that ever replaces it with real Supabase data. Shifts,
  Bills, Paystubs, and Connect tabs all correctly use real data; the core
  spending/budget/Safe-to-Spend dashboard does not. The app's own Connect-tab
  copy says as much: "Connecting a bank replaces nothing shown elsewhere in
  this app yet." **Once a bank is connected and real transactions exist in
  the `transactions` table, wiring the dashboard to read them (instead of
  the fixture) is the highest-value next task** — everything downstream
  (categorization, transfer detection, Safe-to-Spend, subscriptions) is
  already built and tested against the same data shape, it just needs a real
  source instead of the fixture.

## Loose ends (not blocking, but real)

1. **`SUPABASE_ACCESS_TOKEN` GitHub secret expires 2026-09-10.** See above —
   rotate it before then or CI deploys silently go back to no-op.
2. **`GOOGLE_CLIENT_ID`/`SECRET` are on a Testing-mode consent screen**, not
   verified/published. Fine indefinitely at household scale (100 test-user
   cap, only 2 in use), but if this ever needs to work for a Gmail address
   that isn't pre-listed as a test user, add it at
   console.cloud.google.com/auth/audience?project=family-budget-505203
   first — there's no other way in while Testing status holds.
3. **~30 stale branches on the remote** (`payroll-v1` through `-v6`,
   `payroll-engine-*`, `payroll-groundwork-*`, `payroll-system-a` through
   `-h`, `x-pay`, etc.) — almost all point at the same abandoned commit
   `4645f57`. Cosmetic clutter only, nothing depends on them. Fine to
   delete in a batch; ask before doing it since it's a bulk destructive git
   operation.
4. **`claude/family-budget-shared-accounts-djv89t`** — the old working
   branch, fully merged, safe to delete.
5. **The dashboard-still-uses-demo-data gap** — see above, this is the real
   next feature, not a loose end exactly, but it's the thing standing
   between "bank connected" and "app shows your actual numbers."

## What only the owner can do next

1. **Connect a real bank** in the app — Plaid is live on production now
   (see above), so this is a real bank login, not a sandbox test bank.
2. **Invite the second household member** from the Connect tab — needs
   their email; they need a pending invite to sign up at all now.
3. **Connect Gmail** for bill-scanning from the Connect tab — OAuth is fully
   configured now; this should just work for either of the two test-user
   emails listed above.

## Tooling now available on this machine (wasn't, at session start)

This session set up local tooling that didn't exist before, so a future
session on this same machine doesn't need to redo it:

- `gh` (GitHub CLI) installed at `~/.local/bin/gh`, authenticated as
  `sifuentestrey`, and wired into git's global credential helper — `git
  push`/`pull` against this repo just work now, no prompts.
- Supabase CLI downloaded to a session-scoped temp path (NOT permanent —
  re-download from github.com/supabase/cli/releases/latest if a future
  session needs it again; used here only for `supabase secrets set`, which
  needs `SUPABASE_ACCESS_TOKEN` in the environment and must be run from
  inside the repo directory, not an arbitrary directory — the CLI resolves
  `supabase/config.json` relative to cwd and errors confusingly otherwise).

## Deliberately not done yet

- Email/push delivery beyond the existing outbound alert emails — check
  current alert wiring before assuming this is still true, PR #6 added
  outbound alert emails.
- Anything past what's listed above — check `git log --oneline -20` for
  the actual current edge, this file is a snapshot, not a live view.

## How to verify state quickly in a new session

```sql
-- against project ytkpthlhtbxtvtadepqt via Supabase MCP tools
select count(*) from auth.users;                              -- 1
select count(*) from items;                                   -- 0 until a bank is connected
select count(*) from household_invites;                       -- 0 until someone is invited
select jobname, active from cron.job;                          -- 3 rows, all active=true
select count(*) from vault.secrets where name='sync_secret';   -- 1
```

```bash
# Plaid config, unauthenticated, never echoes secret values:
curl https://ytkpthlhtbxtvtadepqt.supabase.co/functions/v1/plaid-health
# expect: "ready": true, "PLAID_ENV": "set to 'production'"
```

```bash
git fetch origin && git log --oneline origin/main -10
npm install && npm test 2>&1 | tail -8   # expect 269+ passing, 0 failing
```

## Tone/process notes for the next session

- User wants **all automation, nothing manual unless ABSOLUTELY necessary**,
  and generally prefers the agent to just act rather than ask for each step
  — but still confirm before anything destructive/hard-to-reverse (bulk
  branch deletion, force-push, minting new credentials) or anything that
  needs information only the owner has (bank login, spouse's email).
- The user is non-technical — doesn't use the terminal, described their own
  input as "pressing random buttons." Don't hand them shell commands to run
  as the primary path; do the work directly (this session had local shell
  + GitHub + Supabase MCP access and used all three) and explain outcomes
  in plain language.
- This repo is **public**. Before adding anything, sanity-check it's not
  real financial data (`.gitignore` already blocks `data/*`, `*.csv`, etc. —
  don't weaken that).
- Don't trust an old handoff doc's "current state" section at face value —
  this file itself was stale by one day and had already-merged work
  described as still pending. Verify against the live DB and `git log`
  before acting on anything a handoff claims.
