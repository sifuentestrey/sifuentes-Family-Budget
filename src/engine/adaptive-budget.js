/**
 * Adaptive category budgets.
 *
 * A hard monthly target is useful for dining or shopping, but it is a poor
 * model for necessities whose real cost moves around (groceries, fuel,
 * electricity, water). This engine keeps one simple contract:
 *
 *   - a household-set target always wins;
 *   - otherwise recent actual spending becomes a suggested target;
 *   - variable essentials also carry a visible recent range so a $430 power
 *     month is not presented as a failure just because last month was $310.
 *
 * The output is presentation-agnostic and is shared by Budget and Money Plan.
 */

export const VARIABLE_ESSENTIAL_CATEGORIES = new Set([
  'Utilities',
  'Groceries',
  'Gas',
  'Pharmacy',
]);

const ROLL_FORWARD_CATEGORIES = new Set([
  'Rent/Mortgage',
  'Utilities',
  'Internet/Phone',
  'Insurance',
  'Car Insurance',
  'Health Insurance',
  'Car Payment',
  'Childcare',
  'Subscriptions',
  'Groceries',
  'Gas',
  'Pharmacy',
]);

const round = (n) => Math.round(Number(n || 0) * 100) / 100;
const monthOf = (date) => String(date ?? '').slice(0, 7);

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function roundUseful(n) {
  const value = Number(n || 0);
  if (!value) return 0;
  if (value < 25) return Math.ceil(value);
  return Math.ceil(value / 5) * 5;
}

function spendRows(transactions = []) {
  const splitParents = new Set(
    transactions.map((t) => t.parent_transaction_id).filter(Boolean),
  );
  return transactions.filter((t) =>
    !t.pending
      && !t.is_transfer
      && !t.is_income
      && Number(t.amount) > 0
      && !splitParents.has(t.id),
  );
}

function totalsByMonthAndCategory(transactions) {
  const table = new Map();
  for (const txn of spendRows(transactions)) {
    const month = monthOf(txn.posted_date);
    const category = txn.category || 'Uncategorized';
    if (!table.has(month)) table.set(month, new Map());
    const row = table.get(month);
    row.set(category, round((row.get(category) || 0) + Number(txn.amount)));
  }
  return table;
}

/**
 * Build one month's category budget picture.
 *
 * @returns {{month:string, rows:Array<object>, totals:object}}
 */
export function buildAdaptiveBudget({ transactions = [], targets = {}, month } = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(month ?? ''))) throw new Error('month must be YYYY-MM');

  const table = totalsByMonthAndCategory(transactions);
  const current = table.get(month) ?? new Map();
  const historyMonths = [...table.keys()].filter((m) => m < month).sort().slice(-4);

  const categories = new Set([...current.keys(), ...Object.keys(targets || {})]);
  for (const category of ROLL_FORWARD_CATEGORIES) {
    if (historyMonths.some((m) => Number(table.get(m)?.get(category) || 0) > 0)) categories.add(category);
  }

  const rows = [...categories].map((category) => {
    const history = historyMonths
      .map((m) => Number(table.get(m)?.get(category) || 0))
      .filter((amount) => amount > 0);

    const manuallySet = Object.prototype.hasOwnProperty.call(targets || {}, category)
      && Number.isFinite(Number(targets[category]));

    let low = null;
    let high = null;
    let suggested = null;

    if (history.length) {
      low = round(percentile(history, 0.25));
      high = round(percentile(history, 0.75));
      if (history.length === 2) {
        low = Math.min(...history);
        high = Math.max(...history);
      }
      if (VARIABLE_ESSENTIAL_CATEGORIES.has(category)) {
        // A variable necessity should be planned near the upper end of its
        // normal range, not at the mean that half its months exceed.
        suggested = roundUseful(percentile(history, 0.75));
      } else {
        suggested = roundUseful(percentile(history, 0.5));
      }
    }

    const planned = manuallySet ? round(Number(targets[category])) : suggested;
    const spent = round(current.get(category) || 0);
    const remaining = planned == null ? null : round(planned - spent);

    return {
      category,
      spent,
      planned,
      remaining,
      over: planned != null && spent > planned,
      source: manuallySet ? 'set' : suggested != null ? 'adaptive' : 'unset',
      variable: VARIABLE_ESSENTIAL_CATEGORIES.has(category),
      typicalLow: low,
      typicalHigh: high,
      historyMonths: history.length,
    };
  }).sort((a, b) => {
    const aEssential = ROLL_FORWARD_CATEGORIES.has(a.category) ? 0 : 1;
    const bEssential = ROLL_FORWARD_CATEGORIES.has(b.category) ? 0 : 1;
    return aEssential - bEssential
      || Number(b.planned ?? b.spent) - Number(a.planned ?? a.spent)
      || a.category.localeCompare(b.category);
  });

  const planned = round(rows.reduce((sum, row) => sum + Number(row.planned || 0), 0));
  const spent = round(rows.reduce((sum, row) => sum + Number(row.spent || 0), 0));

  return {
    month,
    rows,
    totals: {
      planned,
      spent,
      remaining: round(planned - spent),
      setCount: rows.filter((row) => row.source === 'set').length,
      adaptiveCount: rows.filter((row) => row.source === 'adaptive').length,
    },
  };
}

/**
 * Monthly planning amount for one category. Useful when a paycheck plan needs
 * the same budget assumptions without rebuilding UI state.
 */
export function plannedCategoryAmount({ transactions = [], targets = {}, month, category } = {}) {
  return buildAdaptiveBudget({ transactions, targets, month }).rows
    .find((row) => row.category === category)?.planned ?? null;
}
