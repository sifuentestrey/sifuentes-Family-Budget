// GENERATED FILE — do not edit.
// Source of truth: src/engine/recurring.js
// Regenerate with: npm run sync:shared
/**
 * Generic recurring-stream detection.
 *
 * Detecting a Netflix charge every month and a paycheck every two weeks is the
 * same problem: group transactions by counterparty, infer a cadence from the
 * gaps between them, project the next occurrence. Income detection was written
 * first and hard-filtered to deposits; this is that logic with the direction
 * made a parameter.
 *
 * `income.js` now delegates here, so paychecks and subscriptions cannot drift
 * apart in how they are recognized.
 */

import { payeeKey } from './normalize.js';
import { inferCadence, projectNext } from './cadence.js';

/**
 * Occurrences required before a stream is reported with confidence.
 *
 * Income uses 3 because a false paycheck would corrupt the whole budget.
 * Subscriptions use 2: a monthly charge needs three months to reach three
 * occurrences, which is far too slow to be useful for something whose entire
 * value is catching a subscription early. Two-occurrence streams are reported
 * at low confidence rather than hidden.
 */
export const CONFIDENT_OCCURRENCES = 3;
export const MIN_OCCURRENCES = 2;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(n) {
  return Number(n.toFixed(2));
}

/**
 * Detect recurring streams in one direction.
 *
 * @param {Array<object>} transactions
 * @param {object} opts
 * @param {'inflow'|'outflow'} opts.direction - inflow = deposits, outflow = charges
 * @param {number} [opts.minOccurrences]
 * @param {boolean} [opts.requireCadence=true] - drop streams with no clear rhythm
 * @returns {Array<object>} streams
 */
export function detectRecurringStreams(transactions, opts = {}) {
  const direction = opts.direction ?? 'outflow';
  const minOccurrences = opts.minOccurrences ?? MIN_OCCURRENCES;
  const requireCadence = opts.requireCadence ?? true;

  // Plaid's sign convention: positive is money out.
  const wantOutflow = direction === 'outflow';

  const groups = new Map();
  for (const txn of transactions) {
    if (txn.pending) continue;
    // Transfers are excluded in both directions. A credit card autopay recurs
    // monthly and is emphatically not a subscription; money moved to savings
    // is not income. Getting this wrong puts the household's largest recurring
    // "charge" at the top of the subscriptions list every month.
    if (txn.is_transfer) continue;
    if (wantOutflow ? txn.amount <= 0 : txn.amount >= 0) continue;
    // Detected income should not also appear as a recurring charge.
    if (wantOutflow && txn.is_income) continue;

    const key = `${txn.account_id}::${payeeKey(txn.payee)}`;
    if (!groups.has(key)) {
      groups.set(key, { account_id: txn.account_id, payee: txn.payee, items: [] });
    }
    groups.get(key).items.push(txn);
  }

  const streams = [];
  for (const group of groups.values()) {
    if (group.items.length < minOccurrences) continue;

    const sorted = [...group.items].sort((a, b) => a.posted_date.localeCompare(b.posted_date));
    const dates = sorted.map((t) => t.posted_date);
    const amounts = sorted.map((t) => Math.abs(t.amount));

    const cadence = inferCadence(dates);
    if (requireCadence && cadence === 'irregular') continue;

    const lastSeen = dates.at(-1);
    streams.push({
      account_id: group.account_id,
      payee: group.payee,
      category: sorted.at(-1).category ?? null,
      cadence,
      // Median resists a one-off annual charge or a partial first month.
      typical_amount: round(median(amounts)),
      last_amount: round(amounts.at(-1)),
      amounts,
      dates,
      occurrences: sorted.length,
      last_seen: lastSeen,
      next_expected: projectNext(lastSeen, cadence),
      confidence: sorted.length >= CONFIDENT_OCCURRENCES ? 'high' : 'low',
    });
  }

  return streams.sort((a, b) => b.typical_amount - a.typical_amount);
}
