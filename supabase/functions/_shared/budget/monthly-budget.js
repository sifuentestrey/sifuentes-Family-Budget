// GENERATED FILE — do not edit.
// Source of truth: src/engine/budget/monthly-budget.js
// Regenerate with: npm run sync:shared
/**
 * The monthly budget: bills and necessities, with what's left.
 *
 * Everything else in this app answers "what happened" — this answers "what is
 * this month supposed to look like, and are we on track". Two groups, because
 * those are the two kinds of must-pay a household actually reasons about:
 *
 *   bills       - a known payee, a known due date, a known amount. Tracked
 *                 bill records, not guessed from transactions.
 *   necessities - groceries, gas, utilities, pharmacy. No due date, no fixed
 *                 amount, but the money goes out every month regardless.
 *
 * A category that a tracked bill already covers is deliberately NOT repeated
 * as a necessity line. Rent shown as both a $2,350 bill and a $2,350 Housing
 * line makes the month look $2,350 worse than it is, and that error compounds
 * into every "left to spend" figure downstream.
 *
 * Planned amounts default to what the household actually spent in prior
 * months, not to a number they were asked to invent. A budget nobody set up is
 * still a useful budget; one that demanded twelve numbers before showing
 * anything gets abandoned on the setup screen.
 */

import { bucketFor } from '../expenses.js';
import { isSplitParent } from '../split.js';

const round = (n) => Math.round(n * 100) / 100;

/** Buckets that count as "have to pay" rather than "chose to pay". */
const NECESSITY_BUCKETS = new Set(['committed', 'necessary']);

/**
 * Committed by the bucket model, but not a necessity by any household's
 * reckoning: a gym membership and a streaming bundle are the *first* things
 * to go, not things to plan the month around. They're committed because they
 * charge the same amount every month, which is a statement about their
 * rhythm, not their importance. Savings is excluded for a different reason —
 * it's money kept, not money spent, and budgeting it as a cost double-counts
 * it against the plan.
 */
export const NOT_NECESSITIES = new Set(['Subscriptions', 'Fitness', 'Savings']);

/**
 * Prior months with activity needed before a default target is offered.
 * One month is not an average — see trailingAverage in the web app for the
 * same reasoning. Below this the line shows with no target rather than a
 * confident-looking wrong one.
 */
export const MIN_MONTHS_FOR_TARGET = 2;

/** Defaults land on a round number: nobody budgets $487.33 for groceries. */
function roundTarget(n) {
  if (n <= 0) return 0;
  const step = n >= 400 ? 25 : n >= 100 ? 10 : 5;
  return Math.round(n / step) * step;
}

export function monthOf(date) {
  return String(date).slice(0, 7);
}

/**
 * Spending only: transfers, income, pending charges and refunds are all
 * excluded, and so are the children of a split so a split transaction is not
 * counted twice.
 */
export function spendingOnly(transactions) {
  const parents = new Set(
    transactions.map((t) => t.parent_transaction_id).filter(Boolean),
  );
  return transactions.filter(
    (t) => !t.is_transfer && !t.is_income && !t.pending && t.amount > 0
      && !isSplitParent(t, parents),
  );
}

/**
 * Average monthly spend for a category over prior months that had activity.
 * Returns null when there isn't enough history to call it an average.
 */
export function typicalMonthly(transactions, category, month) {
  const totals = new Map();
  for (const t of spendingOnly(transactions)) {
    const m = monthOf(t.posted_date);
    if (m >= month) continue;
    if ((t.category || 'Uncategorized') !== category) continue;
    totals.set(m, (totals.get(m) || 0) + t.amount);
  }
  const values = [...totals.values()].filter((v) => v > 0);
  if (values.length < MIN_MONTHS_FOR_TARGET) return null;
  return round(values.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * @param {object} input
 * @param {object[]} input.transactions
 * @param {object[]} [input.bills]        - domain Bill objects (dueDate, amountDue…)
 * @param {string} input.month            - 'YYYY-MM'
 * @param {Record<string, number>} [input.targets] - category -> planned amount
 * @param {Map<string,string>} [input.overrides]   - category -> bucket
 */
export function buildMonthlyBudget({
  transactions = [], bills = [], month, targets = {}, overrides = new Map(),
} = {}) {
  const spending = spendingOnly(transactions);
  const thisMonth = spending.filter((t) => monthOf(t.posted_date) === month);

  const billItems = bills
    .filter((b) => monthOf(b.dueDate) === month && b.status !== 'ignored')
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
    .map((b) => ({
      id: b.id,
      name: b.providerName,
      category: b.category,
      dueDate: b.dueDate,
      amount: round(b.amountDue),
      paid: b.status === 'paid',
    }));

  // Categories a tracked bill already speaks for. Anything here is left out
  // of the necessity lines so the same dollar is never planned twice.
  const billCategories = new Set(billItems.map((b) => b.category).filter(Boolean));

  const spentByCategory = new Map();
  for (const t of thisMonth) {
    const key = t.category || 'Uncategorized';
    spentByCategory.set(key, (spentByCategory.get(key) || 0) + t.amount);
  }

  // Candidate necessity categories: anything necessary that this household
  // has spent on this month or has history for. A target the user set keeps
  // its line even in a month with no spending yet — that's the point of one.
  const candidates = new Set([
    ...spending.map((t) => t.category).filter(Boolean),
    ...Object.keys(targets),
  ]);

  const necessities = [...candidates]
    .filter((c) => NECESSITY_BUCKETS.has(bucketFor(c, overrides)) && !NOT_NECESSITIES.has(c))
    .filter((c) => !billCategories.has(c))
    .map((category) => {
      const spent = round(spentByCategory.get(category) || 0);
      const typical = typicalMonthly(transactions, category, month);
      const explicit = Number.isFinite(targets[category]) ? round(targets[category]) : null;
      const planned = explicit ?? (typical === null ? null : roundTarget(typical));
      return {
        category,
        planned,
        plannedSource: explicit !== null ? 'set' : planned === null ? 'none' : 'typical',
        typical,
        spent,
        remaining: planned === null ? null : round(planned - spent),
        over: planned !== null && spent > planned,
      };
    })
    .filter((line) => line.planned !== null || line.spent > 0)
    .sort((a, b) => (b.planned ?? b.spent) - (a.planned ?? a.spent));

  const billsPlanned = round(billItems.reduce((s, b) => s + b.amount, 0));
  const billsPaid = round(billItems.filter((b) => b.paid).reduce((s, b) => s + b.amount, 0));
  const necessitiesPlanned = round(
    necessities.reduce((s, l) => s + (l.planned ?? l.spent), 0),
  );
  const necessitiesSpent = round(necessities.reduce((s, l) => s + l.spent, 0));

  const totalSpent = round(thisMonth.reduce((s, t) => s + t.amount, 0));
  const necessityCategorySet = new Set(necessities.map((l) => l.category));
  const otherSpent = round(
    thisMonth
      .filter((t) => !necessityCategorySet.has(t.category || 'Uncategorized'))
      .reduce((s, t) => s + t.amount, 0),
  );

  return {
    month,
    bills: billItems,
    necessities,
    totals: {
      billsPlanned,
      billsPaid,
      billsRemaining: round(billsPlanned - billsPaid),
      necessitiesPlanned,
      necessitiesSpent,
      planned: round(billsPlanned + necessitiesPlanned),
      // What the plan still expects to go out: unpaid bills plus whatever is
      // left of each necessity target (a category already over its target
      // contributes nothing more, not a negative).
      remaining: round(
        (billsPlanned - billsPaid)
        + necessities.reduce((s, l) => s + Math.max(0, l.remaining ?? 0), 0),
      ),
      totalSpent,
      otherSpent,
    },
  };
}
