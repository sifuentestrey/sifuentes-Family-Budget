/**
 * Paycheck forecast.
 *
 * Projects the next check from the pay profile and whatever timecard data
 * exists for the period, and states how much of that period is actually known.
 *
 * Confidence is the point. A forecast built from two days of a ten-day period
 * is a very different object from one built from a complete submitted timecard,
 * and presenting both as "$2,012" invites the household to spend against a
 * number that is mostly extrapolation. The confidence level is derived from how
 * much of the period is covered by real entries, whether overtime and callback
 * — the volatile components — are involved, and how well past forecasts have
 * matched actual stubs.
 */

import { calculatePay } from './pay-calculator.js';

/** @typedef {'high'|'medium'|'low'} ConfidenceLevel */

/**
 * @typedef {object} PaycheckForecast
 * @property {string} payDate
 * @property {{start: string, end: string}} period
 * @property {import('./pay-calculator.js').PayBreakdown} breakdown
 * @property {number} estimatedNet
 * @property {ConfidenceLevel} confidence
 * @property {number} confidenceScore     - 0..1
 * @property {string[]} confidenceReasons
 * @property {number} daysCovered
 * @property {number} daysInPeriod
 * @property {boolean} periodComplete
 * @property {number} [projectedFromPartial] - net if the rest of the period matches so far
 */

const DAY_MS = 86400000;

/**
 * Build the forecast.
 *
 * @param {object} input
 * @param {import('../domain/payroll.js').PayProfile} input.profile
 * @param {import('../domain/payroll.js').TimeEntry[]} input.entries - for this period only
 * @param {{start: string, end: string}} input.period
 * @param {string} input.payDate
 * @param {object} [input.history] - from reconcile.js, tightens confidence
 * @param {string} [input.asOf]    - ISO date, defaults to today
 * @returns {PaycheckForecast}
 */
export function forecastPaycheck(input) {
  const { profile, entries, period, payDate } = input;
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);

  const inPeriod = entries.filter((e) => e.date >= period.start && e.date <= period.end);
  const breakdown = calculatePay(inPeriod, profile);

  const daysInPeriod = Math.max(1, Math.round(
    (Date.parse(`${period.end}T00:00:00Z`) - Date.parse(`${period.start}T00:00:00Z`)) / DAY_MS,
  ) + 1);

  // Elapsed days, not entry count: a 4x10 schedule has three non-working days a
  // week, and counting only days with entries would make a complete week look
  // 57% covered.
  const elapsedMs = Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${period.start}T00:00:00Z`);
  const daysElapsed = Math.min(daysInPeriod, Math.max(0, Math.round(elapsedMs / DAY_MS) + 1));
  const periodComplete = asOf > period.end;
  const daysCovered = periodComplete ? daysInPeriod : daysElapsed;

  const { level, score, reasons } = scoreConfidence({
    breakdown,
    entries: inPeriod,
    daysCovered,
    daysInPeriod,
    periodComplete,
    history: input.history,
  });

  const forecast = {
    payDate,
    period,
    breakdown,
    estimatedNet: breakdown.estimatedNet,
    confidence: level,
    confidenceScore: score,
    confidenceReasons: reasons,
    daysCovered,
    daysInPeriod,
    periodComplete,
  };

  // For an incomplete period, also project forward at the observed rate. Shown
  // as a separate figure rather than replacing the actual-to-date number, so it
  // is never mistaken for money already earned.
  if (!periodComplete && daysCovered > 0 && daysCovered < daysInPeriod) {
    const scale = daysInPeriod / daysCovered;
    forecast.projectedFromPartial = round(breakdown.estimatedNet * scale);
  }

  return forecast;
}

/**
 * Score forecast confidence.
 *
 * Coverage dominates, because everything else is refinement on top of "do we
 * actually know what was worked".
 */
function scoreConfidence({ breakdown, entries, daysCovered, daysInPeriod, periodComplete, history }) {
  const reasons = [];
  let score = 0;

  const coverage = daysInPeriod ? daysCovered / daysInPeriod : 0;
  score += coverage * 0.55;

  if (periodComplete) {
    reasons.push('pay period is complete');
  } else {
    reasons.push(`${Math.round(coverage * 100)}% of the pay period has elapsed`);
  }

  if (!entries.length) {
    return {
      level: 'low',
      score: 0,
      reasons: ['no time entries for this period — nothing to forecast from'],
    };
  }

  // Employer-imported entries are far better evidence than estimates.
  const imported = entries.filter((e) => e.source === 'timecard_import' || e.source === 'provider_api');
  const importedShare = imported.length / entries.length;
  score += importedShare * 0.2;
  if (importedShare === 1) reasons.push('all entries imported from the timekeeping system');
  else if (importedShare > 0) reasons.push(`${Math.round(importedShare * 100)}% of entries imported, rest manual or estimated`);
  else reasons.push('all entries entered manually or estimated');

  // Volatile components make the total less predictable, even with full coverage.
  const volatileGross = breakdown.overtimeGross + breakdown.callbackGross;
  const volatileShare = breakdown.totalGross ? volatileGross / breakdown.totalGross : 0;
  if (volatileShare > 0.25) {
    score -= 0.1;
    reasons.push(`${Math.round(volatileShare * 100)}% of gross is overtime/callback, which varies`);
  }

  // Historical accuracy is the strongest signal available once it exists.
  if (history?.sampleSize >= 3) {
    const accuracy = 1 - Math.min(1, Math.abs(history.meanNetErrorPercent) / 100);
    score += accuracy * 0.25;
    reasons.push(
      `past forecasts differed from actual net by ${history.meanNetErrorPercent.toFixed(1)}% on average ` +
      `across ${history.sampleSize} paychecks`,
    );
  } else {
    reasons.push('no reconciled paystubs yet — tax and deduction rates are still assumptions');
  }

  score = Math.max(0, Math.min(1, score));
  const level = score >= 0.75 ? 'high' : score >= 0.45 ? 'medium' : 'low';

  return { level, score: Number(score.toFixed(3)), reasons };
}

/**
 * Next pay period and payday from a profile.
 *
 * Walks forward from the profile's known anchor period rather than computing
 * from today, so the boundaries stay aligned to the employer's actual calendar.
 *
 * @param {import('../domain/payroll.js').PayProfile} profile
 * @param {string} [asOf]
 */
export function nextPayPeriod(profile, asOf = new Date().toISOString().slice(0, 10)) {
  if (!profile.payPeriodStart || !profile.payPeriodEnd) return null;

  const lengthDays = Math.round(
    (Date.parse(`${profile.payPeriodEnd}T00:00:00Z`) - Date.parse(`${profile.payPeriodStart}T00:00:00Z`)) / DAY_MS,
  ) + 1;

  const lagDays = profile.paydayLagDays ?? (profile.payday
    ? Math.round((Date.parse(`${profile.payday}T00:00:00Z`) - Date.parse(`${profile.payPeriodEnd}T00:00:00Z`)) / DAY_MS)
    : 0);

  let start = profile.payPeriodStart;
  let end = profile.payPeriodEnd;
  let guard = 0;

  // Semi-monthly periods are calendar-anchored (1st-15th, 16th-EOM) and cannot
  // be advanced by a fixed day count without drifting.
  if (profile.payFrequency === 'semimonthly') {
    return advanceSemiMonthly(start, asOf, lagDays);
  }

  while (end < asOf && guard++ < 400) {
    start = addDays(start, lengthDays);
    end = addDays(end, lengthDays);
  }

  return { period: { start, end }, payDate: addDays(end, lagDays) };
}

function advanceSemiMonthly(anchorStart, asOf, lagDays) {
  const date = new Date(`${asOf}T00:00:00Z`);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();

  let start;
  let end;
  if (day <= 15) {
    start = Date.UTC(year, month, 1);
    end = Date.UTC(year, month, 15);
  } else {
    start = Date.UTC(year, month, 16);
    end = Date.UTC(year, month + 1, 0);
  }

  const endIso = new Date(end).toISOString().slice(0, 10);
  return {
    period: { start: new Date(start).toISOString().slice(0, 10), end: endIso },
    payDate: addDays(endIso, lagDays),
  };
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function round(n) {
  return Math.round(n * 100) / 100;
}
