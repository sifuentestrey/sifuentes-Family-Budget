/**
 * Income detection from deposits.
 *
 * Bank feeds carry the net deposit only — gross pay, taxes, and deductions live
 * on the pay stub, which this build deliberately does not fetch automatically.
 * So income here means "money that reliably arrives", which is exactly what
 * cash-flow planning needs.
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
// Cadence logic lives in cadence.js so income.js and recurring.js can both use
// it without importing each other. Re-exported here so existing callers and
// tests that import these from income.js keep working unchanged.
export { inferCadence, projectNext } from './cadence.js';

/** Minimum deposits from one source before we call it a stream. */
const MIN_OCCURRENCES = 3;

/**
 * A repeating $4-$8 deposit is technically recurring income, but it is not a
 * paycheck and must never create a payday in the bills planner. The household
 * has exactly this shape in its bank history: a weekly micro-deposit whose raw
 * description contains "payroll". Name alone is not enough evidence.
 *
 * $100 is deliberately a guardrail, not a model of anyone's salary. It rejects
 * micro-deposits/rewards/verification credits while remaining far below a real
 * paycheck for the use case this app is built around.
 */
export const MIN_TYPICAL_INCOME = 100;

/** Cadences that plausibly represent household pay. */
const PAYCHECK_CADENCES = new Set(['weekly', 'biweekly', 'semimonthly', 'monthly']);

/**
 * Detect recurring income streams.
 *
 * @param {Array<object>} transactions - all accounts; deposits are amount < 0
 * @returns {Array<object>} detected streams
 */
export function detectIncomeStreams(transactions) {
  // Delegates to the generic recurring detector. Detecting a paycheck every
  // two weeks and a recurring charge every month is the same date problem, but
  // income then applies stricter guardrails because a false paycheck corrupts
  // every bill-to-paycheck assignment downstream.
  return detectRecurringStreams(transactions, {
    direction: 'inflow',
    minOccurrences: MIN_OCCURRENCES,
    requireCadence: true,
  }).filter((stream) =>
    PAYCHECK_CADENCES.has(stream.cadence)
      && Number(stream.typical_amount ?? 0) >= MIN_TYPICAL_INCOME,
  );
}

/**
 * Flag transactions belonging to a detected stream as income.
 *
 * Explicitly resets other inflows to false. A stream can stop qualifying after
 * more history arrives; leaving an old `is_income: true` bit behind would make
 * a micro-deposit survive forever even after the detector correctly rejected it.
 */
export function markIncome(transactions, streams) {
  const keys = new Set(streams.map((s) => `${s.account_id}::${payeeKey(s.payee)}`));
  return transactions.map((txn) => {
    if (txn.amount >= 0 || txn.is_transfer) return txn;
    const key = `${txn.account_id}::${payeeKey(txn.payee)}`;
    return { ...txn, is_income: keys.has(key) };
  });
}

/**
 * Expected income for a calendar month, projected from cadence.
 *
 * This is the function that catches three-paycheck months. It walks actual
 * projected dates rather than multiplying a monthly figure, so the extra
 * paycheck appears in the months it genuinely lands in.
 *
 * @param {Array<object>} streams
 * @param {number} year
 * @param {number} month - 1-12
 */
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

/**
 * Count paydays falling inside a month.
 *
 * Fixed-date cadences are constant by definition — semi-monthly is always two
 * and monthly always one, regardless of month length. Only the interval-based
 * cadences need real date walking, and that walk must run in both directions:
 * the anchor is the last observed deposit, which may sit before or after the
 * month being asked about (historical months and forecasts both matter).
 */
function countPaydaysInMonth(stream, start, end) {
  if (stream.cadence === 'semimonthly') return 2;
  if (stream.cadence === 'monthly') return 1;

  const step = stream.cadence === 'weekly' ? 7 : 14;
  const stepMs = step * 86400000;
  const anchor = new Date(stream.last_seen).getTime();

  // Jump straight to the first occurrence at or after `start` instead of
  // looping one step at a time — the anchor can be years away.
  const stepsAway = Math.ceil((start - anchor) / stepMs);
  let cursor = anchor + stepsAway * stepMs;

  let count = 0;
  while (cursor <= end) {
    if (cursor >= start) count++;
    cursor += stepMs;
  }
  return count;
}
