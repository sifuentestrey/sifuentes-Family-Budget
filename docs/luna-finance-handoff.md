# Finance UI handoff

Keep financial calculations in the shared household engine. Do not introduce
independent calculations or payment matching in the UI.

## Screens
- Home: checking first, savings secondary, brief daily advisor note.
- Plan: next paycheck date and labeled estimate, directly followed by bills
  assigned to that check. Collapse supporting detail. Keep monthly paid/unpaid
  bills accessible without misrouting navigation.
- Spending: category budget, spent, remaining until the paycheck boundary.
- Advisor: questions answered using the same household context as Plan.

No “safe to spend” or “uncommitted” number. Clearly label estimates and stale
data. Distinguish a payment date from the month/due date it belongs to. Do not
turn a needs-review item into a paid check mark. Preserve mobile accessibility.

## Logic work completed
- Saved linked payments are checked against provider identity when available.
- Rejected saved payments stay open in the planner and carry needsReview.
- Variable bank-derived estimates can match a different payment amount;
  documentary/manual invoice amounts cannot use that fallback.
- Regression coverage checks changed amounts/dates reassign paycheck totals.
- Batch reconciliation now rejects competing claims across bills and months.
  Review reasons are visible in Bills/Plan and sent to the interactive advisor.
- Documented invoices require cent-exact matches; partial or multiple payments
  stay open for review instead of being silently combined.
- Funding forecasts carry checking forward across future checks, subtract known
  bills and category budgets, flag gaps/carry-in needs, exclude savings, and
  become unknown after incomplete payroll. These are NOT actual reservations.

## Still unresolved — do not conceal in UI
- GitHub backend deployment fails authorization; source changes alone do not
  update deployed Edge Functions.
- No durable, exclusive invoice/payment allocation ledger yet.
- Multiple payments, multiple accounts at one provider, and ambiguous billing
  cycles are flagged, not automatically allocated; fixed date windows remain.
- No automatic verified next invoice amount without a current source document.
- Carry-forward requirements are forecast, but large bills do not yet have
  durable, user-approved reservations across multiple paychecks.
- End-to-end authenticated mobile review remains outstanding.

Use synthetic data in tests/screenshots; never commit household transactions.
