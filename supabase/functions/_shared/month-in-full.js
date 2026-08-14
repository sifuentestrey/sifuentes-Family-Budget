// GENERATED FILE — do not edit.
// Source of truth: src/engine/month-in-full.js
// Regenerate with: npm run sync:shared
/**
 * The month, in full: what went to bills, and where the rest went.
 *
 * "Where it went" as a flat list of categories answers the wrong question.
 * Mortgage, childcare and the power bill are recurring obligations; lumping
 * them in with dining out makes both numbers useless. But a cancellable
 * subscription is not the same thing as the mortgage just because it repeats.
 *
 * So the month splits in two:
 *
 *   bills - recurring household obligations: mortgage/rent, utilities,
 *           insurance, childcare, car payments, taxes, etc. A tracked bill
 *           always counts here; category inference is only the fallback.
 *   rest  - everything else, including subscriptions and other choices.
 *
 * A tracked bill wins over a category guess, because it carries a real payee
 * and a real due date the household confirmed. Categories are the fallback
 * for obligations nobody has told the app about yet.
 */

import { bucketFor } from './expenses.js';
import { findPayingTransaction } from '../domain/bill-payment-match.js';
import { spendingOnly, monthOf } from './budget/monthly-budget.js';

const round = (n) => Math.round(n * 100) / 100;

/**
 * Categories that may be mechanically "committed" but are not household bills.
 *
 * Savings is money kept, not spent. Subscriptions/fitness/entertainment/hobbies
 * are cancellable recurring choices and already have their own Recurring view.
 * Keeping them out here makes "Bills" mean the same thing everywhere.
 */
const NOT_A_BILL = new Set([
  'Savings', 'Subscriptions', 'Fitness', 'Entertainment', 'Hobbies',
]);

export function isBillCategory(category, overrides = new Map()) {
  if (!category || NOT_A_BILL.has(category)) return false;
  return bucketFor(category, overrides) === 'committed';
}

/**
 * @param {object} input
 * @param {object[]} input.transactions
 * @param {object[]} [input.bills]   - domain Bill objects
 * @param {string} input.month       - 'YYYY-MM'
 * @param {Map<string,string>} [input.overrides] - category -> bucket
 */
export function buildMonthInFull({
  transactions = [], bills = [], month, overrides = new Map(),
} = {}) {
  const spending = spendingOnly(transactions);
  const thisMonth = spending.filter((t) => monthOf(t.posted_date) === month);

  // Which transaction paid which tracked bill. Matching runs against the
  // whole month rather than the filtered list so a bill due at the end of
  // one month and paid at the start of the next still finds its charge.
  const paidBy = new Map(); // transaction id -> bill
  for (const bill of bills) {
    if (bill.status === 'ignored') continue;
    const txn = findPayingTransaction(bill, spending);
    const id = txn?.plaid_transaction_id ?? txn?.id;
    if (txn && id && !paidBy.has(id)) paidBy.set(id, bill);
  }

  const billItems = [];
  const restByCategory = new Map();
  let billsTotal = 0;
  let restTotal = 0;

  for (const t of thisMonth) {
    const id = t.plaid_transaction_id ?? t.id;
    const bill = paidBy.get(id);
    const category = t.category || 'Uncategorized';

    if (bill || isBillCategory(t.category, overrides)) {
      billsTotal += t.amount;
      billItems.push({
        id,
        name: bill?.providerName ?? t.payee,
        payee: t.payee,
        category: bill?.category ?? category,
        date: t.posted_date,
        amount: round(t.amount),
        // 'tracked' means the household confirmed this bill exists; 'fixed'
        // means the app inferred it from the category. The UI says which,
        // because one is a fact and the other is a guess.
        source: bill ? 'tracked' : 'fixed',
      });
      continue;
    }

    restTotal += t.amount;
    const entry = restByCategory.get(category) ?? { category, amount: 0, count: 0 };
    entry.amount += t.amount;
    entry.count += 1;
    restByCategory.set(category, entry);
  }

  billItems.sort((a, b) => b.amount - a.amount || a.date.localeCompare(b.date));

  const total = round(billsTotal + restTotal);
  const rest = [...restByCategory.values()]
    .map((g) => ({
      ...g,
      amount: round(g.amount),
      share: restTotal > 0 ? Math.round((g.amount / restTotal) * 100) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  return {
    month,
    total,
    bills: {
      total: round(billsTotal),
      share: total > 0 ? Math.round((billsTotal / total) * 100) : 0,
      items: billItems,
      trackedCount: billItems.filter((b) => b.source === 'tracked').length,
    },
    rest: {
      total: round(restTotal),
      share: total > 0 ? Math.round((restTotal / total) * 100) : 0,
      categories: rest,
      count: rest.reduce((s, g) => s + g.count, 0),
    },
  };
}
