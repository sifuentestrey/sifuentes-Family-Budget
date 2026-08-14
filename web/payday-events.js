/**
 * Payday events for the Bills calendar.
 *
 * Income detection already decides which recurring deposits are real paychecks.
 * This module only turns those trusted streams into calendar events, keeping
 * observed deposits distinct from future projected paydays.
 */
import { projectNext } from '../src/engine/cadence.js';

const monthOf = (date) => String(date ?? '').slice(0, 7);
const round = (n) => Math.round(Number(n || 0) * 100) / 100;

/**
 * @param {Array<object>} streams output from detectIncomeStreams()
 * @param {string} month YYYY-MM
 * @returns {Array<{date:string,status:'deposited'|'expected',amount:number,payee:string,cadence:string}>}
 */
export function buildPaydayEvents(streams = [], month) {
  if (!/^\d{4}-\d{2}$/.test(String(month ?? ''))) throw new Error('month must be YYYY-MM');

  const events = [];

  for (const stream of streams) {
    const dates = stream.dates ?? [];
    const amounts = stream.amounts ?? [];
    const actualDates = new Set();

    for (let i = 0; i < dates.length; i += 1) {
      const date = dates[i];
      if (monthOf(date) !== month) continue;
      actualDates.add(date);
      events.push({
        date,
        status: 'deposited',
        amount: round(amounts[i] ?? stream.last_amount ?? stream.typical_amount),
        payee: stream.payee,
        cadence: stream.cadence,
      });
    }

    let next = stream.next_expected ?? projectNext(stream.last_seen, stream.cadence);
    let guard = 0;
    while (next && monthOf(next) < month && guard++ < 120) {
      const projected = projectNext(next, stream.cadence);
      if (!projected || projected <= next) {
        next = null;
        break;
      }
      next = projected;
    }

    while (next && monthOf(next) === month && guard++ < 140) {
      if (!actualDates.has(next)) {
        events.push({
          date: next,
          status: 'expected',
          amount: round(stream.typical_amount),
          payee: stream.payee,
          cadence: stream.cadence,
        });
      }
      const projected = projectNext(next, stream.cadence);
      if (!projected || projected <= next) break;
      next = projected;
    }
  }

  return events.sort((a, b) => a.date.localeCompare(b.date)
    || (a.status === 'deposited' ? -1 : 1)
    || String(a.payee).localeCompare(String(b.payee)));
}
