# Handoff — Family Budget

Paste this into a new chat to resume. Written 2026-08-11 (supersedes the
2026-08-10 version — that one described work as still in progress on branch
`claude/family-budget-shared-accounts-djv89t`; all of it has since merged to
`main` through PR #9, and this file is the corrected, verified state).

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

- **269 tests passing** (`npm test`), 0 failing. Note: `node_modules` is not
  checked in — a fresh clone/machine needs `npm install` before tests will
  run (the `unpdf` dependency fails to resolve otherwise).
- **1 user in `auth.users`** — the owner has signed up. Household exists.
- **No bank connected yet** — `items` table is empty. This needs the owner,
  in-app, with real bank credentials; not something an agent can or should
  do.
- **No invites sent yet** — `household_invites` is empty. Needs the second
  household member's email, which only the owner has.
- **The sync-transactions auth bug fix IS deployed and live**, not just
  committed — confirmed by reading the deployed function body directly via
  Supabase MCP (`get_edge_function`), not just checking git. It reads the
  bearer secret from Vault, fails closed if unset, constant-time compares.
- **Vault has `sync_secret`** (1 row), and three `pg_cron` jobs are active:
  `daily-transaction-sync` (09:00 UTC), `daily-bill-sync` (09:15 UTC),
  `daily-alert-email` (09:30 UTC).
- **The GitHub Actions Supabase-deploy workflow (`supabase.yml`) has never
  actually deployed anything** — `SUPABASE_ACCESS_TOKEN` was never added as
  a repo secret, so every run so far (4 runs, ~10s each) hit the "not set —
  skipping deploy" branch and exited green without doing anything. This has
  NOT caused any real gap: whoever worked this repo after the handoff
  deployed the edge function and migrations directly via the Supabase MCP
  tool instead of relying on CI. Still worth fixing so future changes to
  `supabase/` don't silently no-op on merge — see Loose ends.
- Shift logging, invite-only signup, Gmail bill scanning, PDF paystub
  attachments, outbound alert emails, paystub reconciliation, and
  Safe-to-Spend-as-the-authoritative-dashboard-number are all built, tested,
  and merged (PRs #2, #4, #6, #7, #8, #9).

## Loose ends (not blocking, but real)

1. **`SUPABASE_ACCESS_TOKEN` still isn't a GitHub secret.** Get one from
   https://supabase.com/dashboard/account/tokens and add it as a repo
   secret so `supabase.yml` actually deploys on merge instead of
   silently skipping. Optional: `SUPABASE_DB_PASSWORD` too, so CI can push
   migrations (currently still done by hand via MCP).
2. **~30 stale branches on the remote** (`payroll-v1` through `-v6`,
   `payroll-engine-*`, `payroll-groundwork-*`, `payroll-system-a` through
   `-h`, `x-pay`, etc.) — almost all point at the same abandoned commit
   `4645f57`. Cosmetic clutter only, nothing depends on them. Fine to
   delete in a batch; ask before doing it since it's a bulk destructive git
   operation.
3. **`claude/family-budget-shared-accounts-djv89t`** — the old working
   branch, fully merged, safe to delete.

## What only the owner can do next

1. **Connect a bank** in the app. Recommended order: sandbox first (proves
   the sync pipeline end-to-end — confirmed it has never run against real
   Plaid), then flip `PLAID_ENV` to `production` and connect real accounts.
2. **Invite the second household member** from the Connect tab — needs
   their email; they need a pending invite to sign up at all now.

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
