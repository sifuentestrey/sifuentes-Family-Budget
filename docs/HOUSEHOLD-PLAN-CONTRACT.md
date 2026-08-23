# Household Plan Contract

This is the deterministic read model for the Family Budget command center. It replaces the legacy "safe to spend" and "uncommitted" outputs. It is deliberately small: present facts, clearly labelled forecasts, and the next decision.

## Product rules encoded by the contract

- **Checking now** is the only prominent bank-balance fact. Savings is returned separately and must never be merged into a headline number.
- **Bills due before payday** use only open bills whose due date falls before the next known paycheck.
- **A bill belongs to the latest paycheck on or before its due date.** A verified bill amount overrides an estimate; each bill carries its amount source and confidence.
- **A paycheck marked incomplete stays a forecast.** The engine returns no "expected checking after this plan" number for it.
- **Flexible spending is an allowance until payday**, calculated day by day across month boundaries from approved monthly targets. It is not a transfer of money and does not claim a category is funded.
- Transfers, income, pending transactions, and split-parent records are excluded from category spending.
- A negative projection becomes a specific funding-gap explanation; raw negative values are not used as a headline.
- The engine has no mutation capability. It cannot pay bills, move money, trade, or change an account.

## Snapshot shape

```js
{
  version: 1,
  asOf: 'YYYY-MM-DD',
  facts: {
    checking: { available, current, accountCount, label: 'Checking now' },
    savings: { available, accountCount, label: 'Savings' },
    dueBeforeNextPayday: { total, bills, label }
  },
  forecasts: {
    nextPaycheck: { date, amount, status, basis, confidence, isFinal, label },
    followingPaycheck,
    nextPaycheckPlan: {
      bills, billsTotal, expectedCheckingAfterAssignedBills,
      label: 'Expected checking after this plan',
      confidence, basedOn
    },
    laterBills
  },
  allowances: [{ category, planned, spent, left, overBy, daysRemaining, label }],
  attention: [{ type, priority, label, reason, confidence }],
  diagnostics: { checkingBalanceIsAvailable, daysUntilNextPaycheck, projectedCheckingAtPayday }
}
```

## Inputs and precedence

1. Connected checking accounts provide the current fact. Prefer an available balance; use current balance only if the provider has no available balance.
2. Exact bills from the household ledger override recurring estimates.
3. Payroll/paystub records override income-stream fallback. Explicit incomplete timecards are never final.
4. User-approved monthly budget targets determine flexible spending allowances. No target means no allowance bar.
5. Posted household purchases count toward category spending. Income, transfers, pending records, and split parent transactions do not.

The snapshot is an adapter boundary. The current UI can adopt it without a database migration; later a Supabase read model may persist the same versioned output after security review.
