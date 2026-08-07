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

/** Minimum deposits from one source before we'll call it a stream. */
const MIN_OCCURRENCES = 3;

/** Expected gap in days, and how much a real payroll schedule can wobble. */
const CADENCE_PROFILES = [
  { cadence: 'weekly', days: 7, tolerance: 2 },
  { cadence: 'biweekly', days: 14, tolerance: 3 },
  { cadence: 'semimonthly', days: 15.2, tolerance: 3 },
  { cadence: 'monthly', days: 30.4, tolerance: 4 },
];

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function daysBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 86400000;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

/**
 * Infer cadence from the gaps between deposits.
 *
 * Uses the median gap, not the mean: a single missed or advanced deposit (a
 * holiday shifting payday) would drag a mean far enough to misclassify the
 * whole stream.
 *
 * Biweekly vs semi-monthly is the hard case and the one that matters most —
 * they differ by two paychecks a year, and confusing them silently corrupts
 * every month's income projection. Their median gaps are nearly identical
 * (14 vs ~15.2), so the gap alone cannot separate them.
 *
 * The reliable signal is day-of-month. Semi-monthly pay lands on the same two
 * dates every month (typically the 1st and 15th), so the distinct day-of-month
 * count stays at 2 no matter how long the history. Biweekly pay walks the
 * calendar — 26 deposits a year hit ~26 different dates. Gap variance is kept
 * as a secondary check for schedules that wobble around weekends and holidays.
 */
export function inferCadence(dates) {
  if (dates.length < 2) return 'irregular';
  const sorted = [...dates].sort();
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(daysBetween(sorted[i - 1], sorted[i]));
  }

  const med = median(gaps);

  if (med >= 12 && med <= 18) {
    const distinctDays = new Set(sorted.map((d) => new Date(d).getUTCDate()));

    // Two fixed dates every month: unambiguously semi-monthly.
    if (distinctDays.size <= 2) return 'semimonthly';

    // Weekend/holiday shifts blur the dates. Fall back to gap variance:
    // biweekly gaps are rigidly 14, semi-monthly alternates 13-17.
    const spread = median(gaps.map((g) => Math.abs(g - med)));
    if (spread > 0.9) return 'semimonthly';

    return 'biweekly';
  }

  for (const profile of CADENCE_PROFILES) {
    if (Math.abs(med - profile.days) <= profile.tolerance) return profile.cadence;
  }
  return 'irregular';
}

/**
 * Project the next expected deposit date.
 * Semi-monthly is projected to the next 1st or 15th rather than by adding days,
 * since those dates are fixed regardless of the previous gap.
 */
export function projectNext(lastDate, cadence) {
  switch (cadence) {
    case 'weekly': return addDays(lastDate, 7);
    case 'biweekly': return addDays(lastDate, 14);
    case 'monthly': return addDays(lastDate, 30);
    case 'semimonthly': {
      const d = new Date(lastDate);
      const day = d.getUTCDate();
      if (day < 15) {
        d.setUTCDate(15);
      } else {
        d.setUTCMonth(d.getUTCMonth() + 1);
        d.setUTCDate(1);
      }
      return d.toISOString().slice(0, 10);
    }
    default: return null;
  }
}

/**
 * Detect recurring income streams.
 *
 * @param {Array<object>} transactions - all accounts; deposits are amount < 0
 * @returns {Array<object>} detected streams
 */
export function detectIncomeStreams(transactions) {
  const groups = new Map();

  for (const txn of transactions) {
    // Deposits only, and never a transfer — moving your own money between
    // accounts is not income, and counting it would double your apparent pay.
    if (txn.amount >= 0 || txn.is_transfer || txn.pending) continue;
    const key = `${txn.account_id}::${payeeKey(txn.payee)}`;
    if (!groups.has(key)) {
      groups.set(key, { account_id: txn.account_id, payee: txn.payee, items: [] });
    }
    groups.get(key).items.push(txn);
  }

  const streams = [];
  for (const group of groups.values()) {
    if (group.items.length < MIN_OCCURRENCES) continue;

    const dates = group.items.map((t) => t.posted_date);
    const amounts = group.items.map((t) => Math.abs(t.amount));
    const cadence = inferCadence(dates);
    if (cadence === 'irregular') continue;

    const lastSeen = [...dates].sort().at(-1);
    streams.push({
      account_id: group.account_id,
      payee: group.payee,
      cadence,
      // Median, not mean: a bonus or a partial first check shouldn't move the
      // number the household plans against.
      typical_amount: Number(median(amounts).toFixed(2)),
      occurrences: group.items.length,
      last_seen: lastSeen,
      next_expected: projectNext(lastSeen, cadence),
    });
  }

  return streams.sort((a, b) => b.typical_amount - a.typical_amount);
}

/** Flag transactions belonging to a detected stream as income. */
export function markIncome(transactions, streams) {
  const keys = new Set(streams.map((s) => `${s.account_id}::${payeeKey(s.payee)}`));
  return transactions.map((txn) => {
    if (txn.amount >= 0 || txn.is_transfer) return txn;
    const key = `${txn.account_id}::${payeeKey(txn.payee)}`;
    return keys.has(key) ? { ...txn, is_income: true } : txn;
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
