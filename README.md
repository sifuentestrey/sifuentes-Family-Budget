# Family Budget

Household budget for two people with shared checking, savings, and credit accounts.
Transactions sync automatically, categorize automatically, and roll up into where the
money actually goes.

## Ground rules

**No real financial data in this repository. Ever.**

Everything committed here is code plus synthetic fixtures with invented numbers.
Real transactions live in the database; secrets live in Supabase secrets. `.gitignore`
blocks `data/`, `.env*`, and every common statement format — but the rule matters more
than the mechanism. Anything pushed to GitHub is durable even after deletion.

**Nothing here can move money.** Bank access is read-only: Plaid is requested with
transaction read scopes only, never `transfer`. Bank credentials are entered on the
bank's own OAuth page and never reach this application — it holds a read-only token,
and that token stays server-side.

## How it works

```
Plaid  ──daily cron──▶  sync Edge Function  ──▶  Postgres (RLS)  ──▶  web app
                              │
                              ├─ normalize payee
                              ├─ detect transfers      ← keeps card payments out of spending
                              ├─ detect income streams ← handles biweekly vs semi-monthly
                              └─ categorize (layered)
```

### Categorization is layered, and the order is the point

| Priority | Layer | What it is |
|---|---|---|
| 1 | `learned` | You corrected this payee before. Permanent, never overridden. |
| 2 | `rule` | Keyword rules — yours first, then ~200 shipped defaults. |
| 3 | `plaid_pfc` | Plaid's own ML category, free with every transaction. |
| 4 | `llm` | Optional, **off by default**. Unknown payees only. |
| 5 | `none` | Uncategorized → review queue. Never a silent guess. |

Pure rules miss every merchant nobody anticipated. Pure AI is non-deterministic — the
same charge landing in different categories across runs means your monthly totals move
without your spending changing, and nobody can explain a number. So deterministic layers
decide what they can, AI only sees the residue, and a human decision always wins.

Every transaction stores `categorized_by`, so any category can be traced to a reason.

### Two things this gets right that budget tools commonly get wrong

**Credit card payments are not spending.** The spending already happened at the swipe.
Counting the payment too inflates monthly spend by everything you pay the cards — on the
sample data, by $3,992.53. Transfer detection matches opposite amounts across linked
accounts within a few days and excludes both sides.

**Biweekly and semi-monthly are different.** A biweekly earner is paid 26 times a year,
so two months contain three paychecks. On the sample data July projects $10,378 against
$8,194 in a normal month. Budgets built on a flat monthly income figure are wrong in
every month.

## What it does not do

- **No gross pay or withholding.** Bank feeds carry only the net deposit. Real pay stub
  data needs Plaid's Payroll Income product, which bills per pull. Income here is
  inferred from recurring deposits: net pay, employer, cadence, next expected date.
- **No financial advice.** It does arithmetic and shows tradeoffs. Tax strategy,
  retirement accounts, insurance adequacy, and investment allocation are out of scope.

## Installing it on your phones

It's a PWA — it installs to the home screen, opens without browser chrome, and
works offline. No app store, no developer accounts, no yearly fee. For two users a
native app would cost $99/yr to Apple plus review cycles and buy nothing.

It has to be served over HTTPS first (see Deploying below). Then:

**iPhone** — open the URL in **Safari** (not Chrome; on iOS every browser is Safari
underneath, but only Safari has the install option). Tap Share → **Add to Home
Screen**. The app shows a reminder the first time.

**Android** — open in Chrome. It'll offer "Install app", or use menu → **Add to
Home screen**.

Notes worth knowing:

- **Push notifications only work once installed**, and only on iOS 16.4+. A Safari
  tab can't receive them — this is an Apple restriction, not a gap in the app.
- The service worker caches the app shell so it opens instantly and works with no
  signal. Financial data is fetched network-first and only falls back to cache when
  offline, so you're never shown a stale balance as though it were current.
- iOS evicts PWA caches after long periods of disuse. Nothing is lost — it just
  re-downloads.

## Deploying

Any static host with HTTPS works; the app is plain files with no build step. Serve
the repository root (not `web/`) — the app imports the engine from `src/engine/`.

```bash
npx netlify deploy --dir . --prod
```

Locally, for testing on a laptop only:

```bash
python3 -m http.server 8899   # then open http://localhost:8899/web/index.html
```

Phones can't install from `localhost` — PWA install requires HTTPS.

## Development

```bash
npm test          # engine tests — offline, synthetic data only
npm run demo      # run the engine on fixtures and print the output
npm run fixtures  # regenerate fixtures
```

The engine (`src/engine/`) is pure functions with no database or network dependency, so
all of it is testable offline. The intended order of work is: prove the engine on
fixtures, then wire sync, then connect a real bank last.

## Setup

1. Create a Supabase project (free tier) and apply `supabase/migrations/`.
2. Create a Plaid account. The Trial plan is free for up to 10 Items — an Item is one
   institution login, not one account.
3. Store `PLAID_CLIENT_ID` and `PLAID_SECRET` as Supabase secrets. Not in `.env`, not
   in the repo.
4. Deploy the `sync-transactions` Edge Function and schedule it daily with `pg_cron`.
5. Connect accounts through Plaid Link in the app.

Banks force re-consent periodically, so reconnecting a few times a year is the one
unavoidable manual step. The dashboard surfaces it rather than failing silently.
