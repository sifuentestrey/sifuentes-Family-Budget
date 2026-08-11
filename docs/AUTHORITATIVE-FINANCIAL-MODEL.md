# Authoritative Financial Model

The application should have one canonical household cash-flow snapshot. The dashboard, Safe-to-Spend card, advisor, alerts, and reports must consume that snapshot rather than independently calculating balances.

## Canonical inputs

1. Available account balances from the latest successful bank sync.
2. Pending transactions classified as actual spending.
3. Unpaid bills due within the planning horizon.
4. Expected income above the configured confidence threshold.
5. Household safety buffer.

Transfers and credit-card payments are ledger movements, not new spending, and must never be reserved as spending a second time.

## Canonical calculation

`safeToSpend = max(0, availableBalance + expectedIncome - pendingSpending - upcomingBills - overdueBills - requiredBuffer)`

The calculation currently uses a 30-day planning horizon. A later product decision can expose additional horizons without changing the underlying ledger classifications.

## Why this exists

A financial application becomes dangerous when separate screens use slightly different definitions of available money. A user should never see one amount on Home, another in Advisor, and another in a report.

The authoritative snapshot returns both the number and an explanation breakdown. This makes the UI auditable and gives the advisor structured facts instead of asking an LLM to perform arithmetic.

## Confidence

Confidence is metadata, not permission to hide uncertainty. Low-confidence expected income is excluded from spendable cash. Bill and income confidence contribute to the snapshot confidence score so the UI can warn when the number is based on incomplete information.

## Integration rule

New financial features should add normalized inputs to the snapshot rather than creating a second Safe-to-Spend implementation.
