# Finance Brain Architecture

## Decision

ChatGPT Finances is the household's financial interpretation and strategy layer.
The Family Budget App is the collector, deterministic calculator, execution layer,
and family-facing UI. Supabase is the app's source of truth and audit trail for
facts that Finances cannot obtain from connected financial accounts.

The system must not create two competing financial brains.

## Authority boundaries

### ChatGPT Finances owns

- connected-account transaction interpretation
- merchant/category interpretation and transfer reasoning
- recurring transaction analysis
- connected balances and account coverage
- liabilities, debt strategy, fees, and interest analysis
- investment context
- household cash-flow reasoning and financial strategy
- affordability and prioritization decisions

Do not copy connected-account transactions, balances, recurring activity,
liabilities, or investments into the app-to-Finances context packet merely to
restate data Finances already owns.

### Family Budget / Supabase owns

- UKG/timecard entries
- employer-specific payroll rules
- current pay periods and paycheck dates
- paycheck forecasts and paystub reconciliation
- exact bills and statement-derived amounts
- email/provider-derived bill metadata
- app workflow state, recommendation status, and audit history

### Deterministic app logic owns

Once a strategy or rule is known, ordinary arithmetic should not require an LLM.
Examples include paycheck forecasting from known hours/rates, bill totals,
reserved-cash calculations, days-until-due, and UI state updates.

## Context bridge

`finance-context` is the outbound bridge from the app to Finances. Its payload is
intentionally compact and app-only. Version 1 contains:

- active payroll profile parameters needed to interpret a paycheck
- the current open pay period
- aggregate timecard hours for that period
- latest paycheck forecast when available
- latest paystub when available
- verified upcoming bills
- counts of recently changed bill/timecard rows
- explicit missing-information flags

The endpoint uses the same dedicated advisor shared secret as `advisor-ingest`.
It supports an optional household id; when exactly one household exists, callers
may omit it.

## Return bridge

`advisor-ingest` is the return path from Finances to the app. Finance
recommendations are stored idempotently by `(household_id, recommendation_id)`.

Recommendations may include `app_changes`, but automatic application is a strict
whitelist rather than arbitrary model-driven writes.

Supported operations:

- `set_transaction_transfer` — may automatically promote an exact Plaid
  transaction to a transfer and clear its income flag.
- `set_transaction_category` — may assign an exact Plaid transaction to an
  existing household category.

Automatic application requires all of the following:

1. The recommendation itself uses `action: apply`.
2. The action identifies an exact `plaid_transaction_id`.
3. Confidence is at least 0.92.
4. The operation is on the whitelist above.
5. A category change does not override `manually_categorized = true`.
6. Transfer auto-application only promotes to transfer; unmarking an existing
   transfer goes to review because it could break a valid pair.

Every attempted action is recorded in `finance_brain_actions` with before/after
state, confidence, outcome, and any error. This is the audit trail for changes
that can affect displayed spending/income totals.

The application layer must never use a Finance recommendation to move money,
make a payment, initiate an investment transaction, delete transaction history,
or perform another real-world financial action.

## Why these changes affect existing app numbers

The existing app calculations already exclude rows where `is_transfer = true`
and already aggregate by the transaction's `category_id`. Therefore a safe
Finance correction to those fields immediately feeds the current deterministic
budget math after the app reloads transaction data. No second parallel Finance
calculation engine is required.

## Usage policy

Do not run a full Finance analysis for every source-data change.

Preferred cadence:

1. A comprehensive Finance review once daily.
2. Deterministic app recomputation during normal intraday changes.
3. Additional Finance review only for material events or an explicit user
   affordability/strategy question.

Material events include a paycheck posting, pay-period close, materially changed
bill, major income change, new debt, or another event that can change household
strategy.

## Financial memories

Use Finances financial memories for durable household truths, not volatile
operational state.

Good memory candidates:

- confirmed transaction interpretation rules
- household transfer rules
- durable budget limits
- savings goals
- unsupported/manual debts or assets
- stable household financial priorities

Do not store changing timecard punches or one-off bill amounts as durable
memories. Those belong in Supabase and the context packet.

## Model roles

- **Sol:** architecture, difficult reasoning, security, major refactors, review
- **Terra:** implementation, integrations, routine debugging, tests, UI/API work
- **Luna:** extraction, normalization, repetitive transformations and low-cost work
- **Finances:** financial interpretation and household strategy

Sol manages the software system. Finances manages financial intelligence.
