/**
 * Bills the household is already paying, proposed from their own transactions.
 *
 * A recurring charge is not automatically a bill. Google, Apple, a gym, and a
 * mortgage can all repeat monthly, but only the mortgage belongs in the Bills
 * plan. Subscriptions already have their own Recurring view. This module is
 * deliberately conservative because a false bill gets assigned to a paycheck
 * and changes the household's plan.
 *
 * Nothing is tracked until the household confirms it. Transaction history can
 * prove that an obligation repeats and estimate its next charge; it cannot know
 * a contractual due date that differs from the day the household paid it.
 */

import { providersMatch } from '../domain/provider-match.js';
import { slugify } from '../domain/bill.js';
import { BILL_CATEGORIES } from '../domain/bill.js';
import { projectNext, daysBetween } from './cadence.js';

const STALE_GRACE_DAYS = 7;
const MAX_ROLL_FORWARD = 24;

/**
 * Normal bill cadences supported by the detector.
 *
 * Weekly/biweekly charges are intentionally excluded: they are much more often
 * habits or shopping patterns than fixed obligations. Quarterly is included
 * because insurance, HOA and tax-style obligations commonly use it.
 */
export const BILLABLE_CADENCES = new Set(['monthly', 'semimonthly', 'quarterly']);

/**
 * Categorizer labels that are genuine household obligations.
 *
 * Subscriptions, entertainment, fitness and hobbies are deliberately absent.
 * A steady price alone is not enough to promote a charge into Bills.
 */
export const OBLIGATION_CATEGORIES = new Set([
  'Rent/Mortgage', 'Utilities', 'Internet/Phone', 'Insurance', 'Car Insurance',
  'Health Insurance', 'Car Payment', 'Childcare', 'Medical', 'Taxes',
]);

/** How far apart two charges can be and still count as "the same price". */
const STABLE_PRICE_TOLERANCE = 0.15;

function round(n) {
  return Number(n.toFixed(2));
}

/** Map a transaction category onto the bill form's shorter vocabulary. */
export function toBillCategory(category) {
  if (!category) return 'Other';
  if (BILL_CATEGORIES.includes(category)) return category;

  const mapped = {
    Fitness: 'Subscriptions',
    Entertainment: 'Subscriptions',
    'Home Maintenance': 'Utilities',
    Pharmacy: 'Medical',
  }[category];

  return mapped ?? 'Other';
}

/** True when every charge in the run is close enough to call it a set price. */
export function isSteadyAmount(amounts) {
  if (!amounts || amounts.length < 2) return false;
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  if (min <= 0) return false;
  return (max - min) / min <= STABLE_PRICE_TOLERANCE;
}

/** Is this stream already being tracked as a bill? */
export function alreadyTracked(stream, bills) {
  return (bills ?? []).some(
    (b) => providersMatch(b.providerName, stream.payee) || providersMatch(b.providerKey ?? '', stream.payee),
  );
}

/** Roll a projected charge forward until it is current/future. */
export function nextDueOnOrAfter(fromDate, cadence, today) {
  let due = fromDate;
  for (let i = 0; i < MAX_ROLL_FORWARD && due < today; i += 1) {
    const advanced = projectNext(due, cadence);
    if (!advanced || advanced <= due) return due;
    due = advanced;
  }
  return due;
}

/** Turn one recurring stream into the bill it would become if confirmed. */
export function streamToBillDraft(stream, today = new Date().toISOString().slice(0, 10)) {
  return {
    providerName: stream.payee,
    providerKey: slugify(stream.payee) || 'recurring',
    category: toBillCategory(stream.category),
    amountDue: round(stream.last_amount ?? stream.typical_amount ?? 0),
    dueDate: nextDueOnOrAfter(stream.next_expected, stream.cadence, today),
  };
}

/**
 * Recurring charges that look like real obligations and are not tracked yet.
 *
 * Fail closed: category evidence is required. A perfectly steady $3.19 Google
 * charge is still a subscription, not a bill, and must never enter the
 * bill-to-paycheck planner simply because the amount is stable.
 */
export function suggestBillsFromTransactions({ streams = [], bills = [], asOf } = {}) {
  const today = asOf ?? new Date().toISOString().slice(0, 10);

  return streams
    .filter((s) => BILLABLE_CADENCES.has(s.cadence))
    .filter((s) => s.next_expected)
    .filter((s) => (s.last_amount ?? s.typical_amount ?? 0) > 0)
    .filter((s) => OBLIGATION_CATEGORIES.has(s.category))
    .filter((s) => !alreadyTracked(s, bills))
    .map((s) => {
      const draft = streamToBillDraft(s, today);
      const steady = isSteadyAmount(s.amounts);
      return {
        ...draft,
        key: `${s.account_id ?? 'acct'}::${draft.providerKey}`,
        cadence: s.cadence,
        typicalAmount: round(s.typical_amount ?? draft.amountDue),
        lastSeen: s.last_seen,
        occurrences: s.occurrences,
        amountVaries: !steady,
        stale: daysBetween(s.next_expected, today) > STALE_GRACE_DAYS,
        reason: `Paid ${s.occurrences} times, ${s.cadence}, ${steady ? 'same amount each time' : 'amount varies'}`,
        confidence: s.occurrences >= 3 && steady ? 'high' : 'low',
      };
    })
    .sort((a, b) => b.amountDue - a.amountDue);
}
