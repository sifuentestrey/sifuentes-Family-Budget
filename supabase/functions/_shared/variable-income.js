// GENERATED FILE — do not edit.
// Source of truth: src/engine/variable-income.js
// Regenerate with: npm run sync:shared
/**
 * Variable income modeling.
 *
 * The original income model stored one median amount per stream and multiplied
 * it by paydays in the month. That is correct for a salary and actively
 * misleading for call-shift work: it reports a confident monthly figure for
 * someone whose checks swing by a factor of two, and a budget anchored to that
 * average is unaffordable in roughly half of all pay periods.
 *
 * The fix is to stop treating income as a number and start treating it as a
 * distribution. Bills get planned against the low end. The gap between the low
 * end and the middle is the money that becomes savings instead of quietly
 * being absorbed into spending.
 *
 * Cadence is unaffected. Call shifts change what you are paid, never when —
 * `inferCadence()` in income.js keys off dates only and needs no changes.
 */

import { payeeKey } from './normalize.js';

/**
 * Coefficient of variation above which a stream is treated as variable.
 *
 * 15% is deliberately low. The cost of misclassifying variable income as
 * stable is a budget that breaks in bad months; the cost of the reverse is a
 * slightly conservative plan that saves more than strictly necessary. Those
 * are not symmetric, so the threshold errs toward caution.
 */
const VARIABILITY_THRESHOLD = 0.15;

/** Minimum observations before a distribution means anything. */
const MIN_SAMPLES = 4;

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

/**
 * Linear-interpolated percentile.
 *
 * Interpolated rather than nearest-rank because these samples are small — with
 * 8 paychecks, nearest-rank p20 snaps to a specific observed check, making the
 * floor jump around as history accrues. Interpolation moves it smoothly.
 */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];

  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[index];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/**
 * Analyze one income stream's amount distribution.
 *
 * @param {Array<number>} amounts - positive magnitudes, most recent last
 * @returns {object} distribution and stability classification
 */
export function analyzeAmounts(amounts) {
  if (!amounts.length) {
    return { stability: 'unknown', samples: 0, floor: 0, median: 0, high: 0, min: 0, max: 0, variability: 0, upside: 0 };
  }

  const avg = mean(amounts);
  const variability = avg ? stdDev(amounts) / avg : 0;

  // Below the sample minimum, assume variable. Claiming stability from three
  // data points would produce a confident floor that has not been earned.
  const stability =
    amounts.length < MIN_SAMPLES
      ? 'unknown'
      : variability > VARIABILITY_THRESHOLD
        ? 'variable'
        : 'stable';

  const floor = percentile(amounts, 20);
  const mid = percentile(amounts, 50);

  return {
    stability,
    samples: amounts.length,
    variability: Number(variability.toFixed(3)),
    // The conservative planning figure — roughly the worst check in five.
    floor: round(floor),
    median: round(mid),
    high: round(percentile(amounts, 80)),
    min: round(Math.min(...amounts)),
    max: round(Math.max(...amounts)),
    // Named explicitly: this is the money the plan converts into savings
    // rather than letting it disappear into a better-than-usual month.
    upside: round(mid - floor),
  };
}

/**
 * Attach distributions to detected income streams.
 *
 * @param {Array<object>} streams - from detectIncomeStreams
 * @param {Array<object>} transactions - to recover per-stream amounts
 */
export function modelIncomeStreams(streams, transactions) {
  return streams.map((stream) => {
    const amounts = transactions
      .filter(
        (t) =>
          t.amount < 0 &&
          !t.is_transfer &&
          t.account_id === stream.account_id &&
          payeeKey(t.payee) === payeeKey(stream.payee),
      )
      .sort((a, b) => a.posted_date.localeCompare(b.posted_date))
      .map((t) => Math.abs(t.amount));

    return { ...stream, distribution: analyzeAmounts(amounts) };
  });
}

/**
 * Paychecks per month for a cadence, as a fractional rate.
 *
 * Biweekly is 26/12, not 2 — that fractional 0.167 is precisely the third
 * paycheck that arrives twice a year. Rounding it to 2 is the error that makes
 * annual planning under-count by two full checks.
 */
function paychecksPerMonth(cadence) {
  switch (cadence) {
    case 'weekly': return 52 / 12;
    case 'biweekly': return 26 / 12;
    case 'semimonthly': return 2;
    case 'monthly': return 1;
    default: return 0;
  }
}

/**
 * Reliable monthly income: what the household can count on in a slow stretch.
 *
 * Stable streams contribute their median; variable streams contribute their
 * p20 floor. This is the number bills are planned against — never the average,
 * because an average is unavailable half the time by construction.
 *
 * @param {Array<object>} modeledStreams - from modelIncomeStreams
 */
export function reliableMonthlyIncome(modeledStreams) {
  let reliable = 0;
  let expected = 0;
  const detail = [];

  for (const stream of modeledStreams) {
    const rate = paychecksPerMonth(stream.cadence);
    if (!rate) continue;

    const dist = stream.distribution;
    // 'unknown' is treated as variable — insufficient history is a reason for
    // caution, not for optimism.
    const useFloor = dist.stability !== 'stable';
    const perCheck = useFloor ? dist.floor : dist.median;

    const reliableAmount = perCheck * rate;
    const expectedAmount = dist.median * rate;

    reliable += reliableAmount;
    expected += expectedAmount;

    detail.push({
      payee: stream.payee,
      cadence: stream.cadence,
      stability: dist.stability,
      basis: useFloor ? 'floor (p20)' : 'median',
      perCheck: round(perCheck),
      monthlyReliable: round(reliableAmount),
      monthlyExpected: round(expectedAmount),
    });
  }

  return {
    reliable: round(reliable),
    expected: round(expected),
    // How much of a typical month is upside rather than dependable. Large
    // values mean the household's plan must lean on the floor, not the middle.
    upside: round(expected - reliable),
    detail,
  };
}

/**
 * Project a specific month using actual payday dates, at floor or median.
 *
 * Kept separate from `projectMonthlyIncome` in income.js: that one answers
 * "what will a typical month look like", this one answers "what is the worst
 * this month plausibly is". Both are needed and they must not be conflated.
 */
export function projectMonthRange(modeledStreams, year, month, countPaydays) {
  let low = 0;
  let mid = 0;
  let high = 0;

  for (const stream of modeledStreams) {
    const checks = countPaydays(stream, year, month);
    low += checks * stream.distribution.floor;
    mid += checks * stream.distribution.median;
    high += checks * stream.distribution.high;
  }

  return { low: round(low), mid: round(mid), high: round(high) };
}

function round(n) {
  return Number(n.toFixed(2));
}
