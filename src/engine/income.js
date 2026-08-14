/**
 * Income detection from deposits.
 *
 * Bank feeds carry the net deposit only — gross pay, taxes, and deductions live
 * on the pay stub, which this build deliberately does not fetch (Plaid's payroll
 * product is billed per pull). So income here means "money that reliably arrives",
 * which is exactly what cash-flow planning needs.
 *
 * The cadence work matters more than it looks. A biweekly earner is paid 26
 * times a year, so two months out of twelve contain three paychecks. Budgets
 * built on "monthly income = paycheck x 2" under-count those months and
 * over-count the other ten. Where two spouses are on different cadences —
 * biweekly and semi-monthly, the most common pairing — the combined picture
 * drifts every single month unless the cadences are modeled separately.
 */

import { payeeKey } from './normalize.js';
import { detectRecurringStreams } from './recurring.js';
export { inferCadence, projectNext } from './cadence.js';

/** Minimum deposits from one source before we call it a stream. */
const MIN_OCCURRENCES = 3;

/**
 * A recurring deposit below this is not useful as a paycheck/income floor.
 * Tiny payroll-looking deposits (cashback, reimbursements, tip adjustments,
 * micro-deposits) can recur on a perfect cadence and otherwise poison the
 * household's projected income. Real one-off income still remains visible as
 * a transaction; it simply is not promoted into a forecast stream.
 */
const MIN_TYPICAL_INCOME = 100;

export function detectIncomeStreams(transactions) {
  return detectRecurringStreams(transactions, {
    direction: 'inflow',
    minOccurrences: MIN_OCCURRENCES,
    requireCadence: true,
  }).filter((stream) => stream.typical_amount >= MIN_TYPICAL_INCOME);
}

/** Flag transactions belonging to a detected stream as income. */
export function markIncome(transactions, streams) {
  const keys = new Set(streams.map((s) => `${s.account_id}::${payeeKey(s.payee)}`));
  return transactions.map((txn) => {
    if (txn.amount >= 0 || txn.is_transfer) return txn;
    const key = `${txn.account_id}::${payeeKey(txn.payee)}`;
    return keys.has(key) ? { ...txn, is_income: true } : { ...txn, is_income: false };
  });
}

export function projectMonthlyIncome(streams, year, month) {
  const start = Date.UTC(year, month - 1, 1);
  const end = Date.UTC(year, month, 0);
  let total = 0;
  const detail = [];

  for (const stream of streams) {
    const count = countPaydaysInMonth(stream, start, end);
    const amount = count * stream.typical_amount;
    total += amount;
    detail.push({ payee: stream.payee, cadence: stream.cadence, paychecks: count, amount });
  }

  return { year, month, total: Number(total.toFixed(2)), detail };
}

function countPaydaysInMonth(stream, start, end) {
  if (stream.cadence === 'semimonthly') return 2;
  if (stream.cadence === 'monthly') return 1;

  const step = stream.cadence === 'weekly' ? 7 : 14;
  const stepMs = step * 86400000;
  const anchor = new Date(stream.last_seen).getTime();
  const stepsAway = Math.ceil((start - anchor) / stepMs);
  let cursor = anchor + stepsAway * stepMs;

  let count = 0;
  while (cursor <= end) {
    if (cursor >= start) count++;
    cursor += stepMs;
  }
  return count;
}
