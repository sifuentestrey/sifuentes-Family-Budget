// GENERATED FILE — do not edit.
// Source of truth: src/engine/bill-suggestions.js
// Regenerate with: npm run sync:shared
/**
 * Bills the household is already paying, proposed from their own transactions.
 *
 * The Bills tab used to have exactly two ways to learn a bill exists: parse an
 * email, or have somebody type it in. Both ignore the best evidence available —
 * that the charge has landed in this account, on a rhythm, for months. A
 * household that pays the same power company every month should not have to
 * tell the app about the power company.
 *
 * This module only proposes. Nothing is tracked until the household taps the
 * suggestion, because a recurring charge is not automatically a bill worth
 * forecasting against (see `subscriptions.js`'s frequentMerchants — a grocery
 * store recurs too), and because a bill entered without a human confirming it
 * would land in the safe-to-spend number as an obligation nobody agreed to.
 *
 * Deliberately pure: takes already-detected streams and the already-tracked
 * bills, returns a list. No fetching, no Supabase, no DOM — so the rules about
 * what counts as a plausible bill are testable on their own.
 */

import { providersMatch } from '../domain/provider-match.js';
import { slugify } from '../domain/bill.js';
import { BILL_CATEGORIES } from '../domain/bill.js';
import { projectNext, daysBetween } from './cadence.js';

/**
 * How far past its expected date a charge can drift before the household is
 * warned it may have stopped.
 *
 * Billing dates move around by a few days as a matter of course — weekends,
 * month lengths, a provider changing its cycle. Treating "one day later than
 * projected" as evidence a subscription ended would put a scary caveat on
 * almost every healthy bill, which is how a caveat stops meaning anything.
 */
const STALE_GRACE_DAYS = 7;

/** Safety bound on the roll-forward loop below; 24 covers two years monthly. */
const MAX_ROLL_FORWARD = 24;

/**
 * Cadences a bill can plausibly have.
 *
 * Bounded by what `inferCadence` can actually return — weekly, biweekly,
 * semimonthly, monthly, irregular. Listing quarterly or annual here would look
 * thorough and match nothing, so an annually-billed insurance premium would
 * appear to be handled while silently never being offered. (Annual charges are
 * already accounted for elsewhere: expenses.js spreads them across the year as
 * "irregular", which is the right treatment for budgeting anyway.)
 *
 * Weekly and biweekly are excluded on purpose. Something charged every week is
 * a habit, not an obligation — a coffee run, a commute, a weekly shop — and
 * putting those on the bills list would bury the four or five charges that
 * genuinely have due dates.
 */
export const BILLABLE_CADENCES = new Set(['monthly', 'semimonthly']);

/**
 * Spending categories that read as obligations rather than shopping.
 *
 * These are the categorizer's own labels, verbatim from
 * src/engine/seed-rules.js — not a plausible-sounding list. A name that never
 * actually occurs would fail silently: the category test would just never
 * match, and real bills would quietly stop being offered with nothing to
 * indicate why.
 */
export const OBLIGATION_CATEGORIES = new Set([
  'Rent/Mortgage', 'Utilities', 'Internet/Phone', 'Insurance', 'Car Insurance',
  'Health Insurance', 'Car Payment', 'Childcare', 'Medical', 'Taxes',
  'Subscriptions', 'Fitness', 'Registration/Fees',
]);

/** How far apart two charges can be and still count as "the same price". */
const STABLE_PRICE_TOLERANCE = 0.15;

function round(n) {
  return Number(n.toFixed(2));
}

/**
 * Map a transaction category onto a bill category.
 *
 * The two vocabularies overlap but are not identical — bills have a fixed
 * short list (BILL_CATEGORIES) that the bill form's dropdown is built from,
 * and a suggestion that pre-fills a category the dropdown cannot show would
 * silently save as something else.
 */
export function toBillCategory(category) {
  if (!category) return 'Other';
  if (BILL_CATEGORIES.includes(category)) return category;

  // Only the categorizer labels that have no identically-named bill category.
  // A gym membership is a subscription once it is a bill; everything else
  // without a home falls to 'Other' rather than being invented.
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

/**
 * Is this stream already being tracked as a bill?
 *
 * Matched fuzzily on provider name rather than exactly, because the same
 * company arrives spelled three different ways depending on the channel (see
 * provider-match.js). A false negative here is the expensive one: it offers a
 * household a bill they already track, and accepting it risks a duplicate.
 */
export function alreadyTracked(stream, bills) {
  return (bills ?? []).some(
    (b) => providersMatch(b.providerName, stream.payee) || providersMatch(b.providerKey ?? '', stream.payee),
  );
}

/**
 * The next occurrence of a stream that is still in the future.
 *
 * A stream's `next_expected` is projected from its last charge, so by the time
 * anybody looks at it, it may already have passed — the charge landed and the
 * transaction hasn't synced, or the cycle drifted. Saving that date verbatim
 * would create a bill that is overdue the moment it exists, which then shows
 * up in red on Home and in the "due before your next check" group. Walking it
 * forward by the stream's own cadence gives the date the household actually
 * needs money by.
 */
export function nextDueOnOrAfter(fromDate, cadence, today) {
  let due = fromDate;
  for (let i = 0; i < MAX_ROLL_FORWARD && due < today; i += 1) {
    const advanced = projectNext(due, cadence);
    if (!advanced || advanced <= due) return due;
    due = advanced;
  }
  return due;
}

/**
 * Turn one recurring stream into the bill it would become.
 *
 * Amount is the *last* charge, not the median: after a price rise the median
 * lags behind what the household will actually be asked for, and a bill is a
 * forecast of the next payment, not a summary of past ones.
 */
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
 * Recurring charges that look like bills and are not tracked yet.
 *
 * @param {object} input
 * @param {Array<object>} input.streams - recurring outflow streams (recurring.js shape)
 * @param {Array<object>} [input.bills] - bills already tracked, any source
 * @param {string} [input.asOf] - ISO date; suggestions with a due date already
 *   in the past are still offered, but flagged, since a stale next_expected
 *   usually means the charge stopped rather than that a bill is overdue.
 * @returns {Array<object>} suggestions, most consequential first
 */
export function suggestBillsFromTransactions({ streams = [], bills = [], asOf } = {}) {
  const today = asOf ?? new Date().toISOString().slice(0, 10);

  return streams
    .filter((s) => BILLABLE_CADENCES.has(s.cadence))
    .filter((s) => s.next_expected)
    .filter((s) => (s.last_amount ?? s.typical_amount ?? 0) > 0)
    // A category we recognize as an obligation, or a set price paid at least
    // three times. Either one on its own is weak evidence; a variable charge
    // in an unknown category is just a merchant the household visits often.
    .filter((s) => OBLIGATION_CATEGORIES.has(s.category) || (isSteadyAmount(s.amounts) && s.occurrences >= 3))
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
        // Judged on where the charge was *expected*, not on the rolled-forward
        // date above — that one is always in the future by construction.
        stale: daysBetween(s.next_expected, today) > STALE_GRACE_DAYS,
        // Written as evidence, not as a claim — the household is being asked
        // to confirm something about their own life, and the honest version of
        // that is showing what was observed.
        reason: `Paid ${s.occurrences} times, ${s.cadence}, ${steady ? 'same amount each time' : 'amount varies'}`,
        confidence: s.occurrences >= 3 && steady ? 'high' : 'low',
      };
    })
    // Biggest first: the ones worth putting money aside for.
    .sort((a, b) => b.amountDue - a.amountDue);
}
