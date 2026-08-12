/**
 * The year, not the month.
 *
 * Every screen in this app is scoped to one month, which answers "how are we
 * doing" and cannot answer "what does a year of us actually look like". The
 * questions that need a year are the ones worth asking: what does eating out
 * cost us annually, is the grocery bill drifting up, which month wrecked us
 * and why.
 *
 * Two deliberate choices about honesty:
 *
 *   The current month is included but marked incomplete. Dropping it hides
 *   money the household has already spent; averaging it in as though it were
 *   finished makes every per-month figure read low. So it is counted, and
 *   labelled, and left out of the averages.
 *
 *   Averages divide by months with activity, never by twelve. A category
 *   bought twice a year is not "$12 a month" — that is a number that has
 *   never once matched reality and cannot be budgeted against.
 */

import { spendingOnly, monthOf } from './budget/monthly-budget.js';
import { isBillCategory } from './month-in-full.js';

const round = (n) => Math.round(n * 100) / 100;

/** The last `count` months ending at `endMonth`, oldest first. */
export function monthsEnding(endMonth, count = 12) {
  const [year, month] = String(endMonth).split('-').map(Number);
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * @param {object} input
 * @param {object[]} input.transactions
 * @param {string} input.endMonth        - 'YYYY-MM', the newest month shown
 * @param {string} [input.currentMonth]  - the month still in progress
 * @param {number} [input.count=12]
 */
export function buildYearInReview({
  transactions = [], endMonth, currentMonth = endMonth, count = 12,
} = {}) {
  const months = monthsEnding(endMonth, count);
  const inRange = new Set(months);

  const spending = spendingOnly(transactions).filter((t) => inRange.has(monthOf(t.posted_date)));
  const income = (transactions ?? []).filter(
    (t) => t.is_income && !t.pending && inRange.has(monthOf(t.posted_date)),
  );

  const byMonth = new Map(months.map((m) => [m, {
    month: m,
    spent: 0,
    bills: 0,
    rest: 0,
    earned: 0,
    count: 0,
    inProgress: m === currentMonth,
  }]));

  const byCategory = new Map();

  for (const t of spending) {
    const entry = byMonth.get(monthOf(t.posted_date));
    entry.spent += t.amount;
    entry.count += 1;
    if (isBillCategory(t.category)) entry.bills += t.amount;
    else entry.rest += t.amount;

    const name = t.category || 'Uncategorized';
    const cat = byCategory.get(name) ?? { category: name, total: 0, count: 0, months: new Map() };
    cat.total += t.amount;
    cat.count += 1;
    cat.months.set(monthOf(t.posted_date), (cat.months.get(monthOf(t.posted_date)) ?? 0) + t.amount);
    byCategory.set(name, cat);
  }

  // Income is stored negative (Plaid's sign convention: money in is negative).
  for (const t of income) {
    byMonth.get(monthOf(t.posted_date)).earned += Math.abs(t.amount);
  }

  const monthRows = months.map((m) => {
    const e = byMonth.get(m);
    return {
      ...e,
      spent: round(e.spent),
      bills: round(e.bills),
      rest: round(e.rest),
      earned: round(e.earned),
      net: round(e.earned - e.spent),
    };
  });

  // Complete months only: the month in progress would drag every average down.
  const complete = monthRows.filter((m) => !m.inProgress && m.spent > 0);

  const categories = [...byCategory.values()]
    .map((c) => {
      const active = [...c.months.values()].filter((v) => v > 0);
      const busiest = [...c.months.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
      return {
        category: c.category,
        total: round(c.total),
        count: c.count,
        monthsSeen: active.length,
        // Per month it actually happened in, never divided by twelve.
        perActiveMonth: active.length ? round(c.total / active.length) : 0,
        biggestMonth: busiest ? { month: busiest[0], amount: round(busiest[1]) } : null,
      };
    })
    .sort((a, b) => b.total - a.total);

  const totalSpent = round(monthRows.reduce((s, m) => s + m.spent, 0));
  const totalEarned = round(monthRows.reduce((s, m) => s + m.earned, 0));
  const totalBills = round(monthRows.reduce((s, m) => s + m.bills, 0));

  return {
    months: monthRows,
    categories,
    totals: {
      spent: totalSpent,
      earned: totalEarned,
      bills: totalBills,
      rest: round(totalSpent - totalBills),
      net: round(totalEarned - totalSpent),
      billsShare: totalSpent > 0 ? Math.round((totalBills / totalSpent) * 100) : 0,
    },
    // Everything the household can compare against: only finished months.
    typical: {
      monthsCounted: complete.length,
      spent: complete.length ? round(complete.reduce((s, m) => s + m.spent, 0) / complete.length) : null,
      earned: complete.length ? round(complete.reduce((s, m) => s + m.earned, 0) / complete.length) : null,
    },
    biggest: complete.length
      ? complete.reduce((worst, m) => (m.spent > worst.spent ? m : worst))
      : null,
  };
}
