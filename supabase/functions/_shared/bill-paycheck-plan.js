// GENERATED FILE — do not edit.
// Source of truth: src/engine/bill-paycheck-plan.js
// Regenerate with: npm run sync:shared
/**
 * Which upcoming paycheck needs to cover which bill.
 *
 * allocate.js already funds bills per check, deliberately levelled across
 * checks rather than tied to due dates ("how big was the check", not "which
 * bills happened to land" — see renderPaycheck's own note on this). That
 * answers "how much should I set aside from this check in general." This
 * answers the other, equally real question a household with variable
 * income asks about a SPECIFIC bill: which specific upcoming paycheck do I
 * need the money in hand by?
 *
 * A bill is assigned to the latest payday landing on or before its due date
 * — the check that, realistically, has to have covered it by then. A bill
 * due before even the next paycheck arrives needs money already in hand,
 * not a future one; a bill due further out than the household's income
 * pattern reaches is reported separately rather than guessed at.
 */
import { projectNext, addDays } from './cadence.js';
import { isUnpaid } from '../domain/bill.js';

const DEFAULT_HORIZON_DAYS = 70;

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Every stream's paydays within the horizon, merged into one sorted,
 * deduplicated timeline. Bounded both by the date cutoff and an iteration
 * guard, so a stream with a cadence that never advances cannot loop forever.
 */
function upcomingPaydays(streams, cutoff) {
  const dates = new Set();
  for (const stream of streams ?? []) {
    let date = stream.next_expected;
    let guard = 0;
    while (date && date <= cutoff && guard++ < 20) {
      dates.add(date);
      date = projectNext(date, stream.cadence);
    }
  }
  return [...dates].sort();
}

/**
 * @param {object[]} bills - Bill domain objects (src/domain/bill.js)
 * @param {object[]} streams - income streams (must carry next_expected, cadence)
 * @param {object} [opts]
 * @param {number} [opts.horizonDays=70] - how far ahead to track paydays
 * @param {string} [opts.asOf] - ISO date, defaults to today
 * @returns {{
 *   groups: {paycheckDate: string, bills: object[], total: number}[],
 *   dueNow: {bills: object[], total: number},
 *   later: {bills: object[], total: number},
 * }}
 */
export function planPaycheckCoverage(bills, streams, { horizonDays = DEFAULT_HORIZON_DAYS, asOf } = {}) {
  const today = asOf ?? new Date().toISOString().slice(0, 10);
  const cutoff = addDays(today, horizonDays);
  const paydays = upcomingPaydays(streams, cutoff);

  const unpaid = (bills ?? []).filter(isUnpaid).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const groups = paydays.map((paycheckDate) => ({ paycheckDate, bills: [] }));
  const dueNow = [];
  const later = [];

  for (const bill of unpaid) {
    // Latest payday on or before the due date — the check that has to have
    // covered it. Bills sort ascending and paydays are sorted ascending, but
    // each bill is checked independently since due dates aren't monotonic
    // relative to paydays.
    let idx = -1;
    for (let i = 0; i < paydays.length; i++) {
      if (paydays[i] <= bill.dueDate) idx = i;
      else break;
    }

    if (bill.dueDate > cutoff) {
      later.push(bill);
    } else if (idx === -1) {
      dueNow.push(bill);
    } else {
      groups[idx].bills.push(bill);
    }
  }

  const totaled = (list) => round(list.reduce((sum, b) => sum + b.amountDue, 0));

  return {
    groups: groups.map((g) => ({ ...g, total: totaled(g.bills) })),
    dueNow: { bills: dueNow, total: totaled(dueNow) },
    later: { bills: later, total: totaled(later) },
  };
}
