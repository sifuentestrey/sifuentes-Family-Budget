// GENERATED FILE — do not edit.
// Source of truth: src/engine/safe-to-spend.js
// Regenerate with: npm run sync:shared
/**
 * Conservative household "Safe to Spend" calculation.
 *
 * This is intentionally a pure function. It does not know about Plaid,
 * Supabase, Gmail, or UKG. Those systems feed normalized values into it.
 *
 * The goal is not to answer "how much cash do I have?". It answers:
 * "How much discretionary cash can I spend while still covering known
 * obligations and preserving the household buffer through the forecast date?"
 */

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function calculateSafeToSpend({
  availableCash = 0,
  pendingOutflows = [],
  billsDueBeforeForecast = [],
  recurringOutflowsBeforeForecast = [],
  expectedIncomeBeforeForecast = [],
  savingsCommitments = [],
  buffer = 0,
} = {}) {
  const cash = money(availableCash);
  const pending = pendingOutflows.reduce((sum, item) => sum + Math.max(0, money(item.amount)), 0);
  const bills = billsDueBeforeForecast.reduce((sum, item) => sum + Math.max(0, money(item.amount)), 0);
  const recurring = recurringOutflowsBeforeForecast.reduce((sum, item) => sum + Math.max(0, money(item.amount)), 0);
  const income = expectedIncomeBeforeForecast.reduce((sum, item) => sum + Math.max(0, money(item.amount)), 0);
  const savings = savingsCommitments.reduce((sum, item) => sum + Math.max(0, money(item.amount)), 0);
  const reserve = Math.max(0, money(buffer));

  const projectedDiscretionary = cash + income - pending - bills - recurring - savings - reserve;
  const safeToSpend = Math.max(0, projectedDiscretionary);

  return {
    availableCash: cash,
    expectedIncome: income,
    pendingOutflows: pending,
    billsDue: bills,
    recurringOutflows: recurring,
    savingsCommitments: savings,
    buffer: reserve,
    projectedDiscretionary,
    safeToSpend,
    constrained: projectedDiscretionary < 0,
  };
}
