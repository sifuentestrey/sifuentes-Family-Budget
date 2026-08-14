/**
 * The operational Bills view.
 *
 * A household does not care which ingestion path discovered an obligation.
 * Mortgage, power, water, insurance and an active subscription all answer the
 * same question on payday: has this been paid, and if not, which check has to
 * cover it?
 *
 * This module merges two kinds of evidence without pretending they are the
 * same thing:
 *   - tracked bills carry the household-confirmed due date and expected amount;
 *   - recurring streams carry what actually cleared and what is expected next.
 *
 * Historical recurring charges stay visible as paid. Future tracked bills stay
 * visible as due. That lets an Aug 3 mortgage payment and the next Sep 1
 * mortgage obligation coexist instead of one replacing the other.
 */

import { findPayingTransaction } from '../domain/bill-payment-match.js';
import { providersMatch } from '../domain/provider-match.js';
import { projectNext } from './cadence.js';

const round = (n) => Math.round(Number(n || 0) * 100) / 100;
const monthOf = (date) => String(date ?? '').slice(0, 7);

function dayDistance(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}

/** Shared preferences are stored in the bill's existing JSON payload. */
export function billPreferences(bill) {
  const planning = bill?.raw?.planning ?? {};
  return {
    paymentMode: planning.paymentMode === 'auto' || planning.paymentMode === 'manual'
      ? planning.paymentMode
      : null,
    amountMode: planning.amountMode === 'fixed' || planning.amountMode === 'variable'
      ? planning.amountMode
      : null,
  };
}

export function matchingRecurringStream(bill, recurring = []) {
  return recurring.find((stream) => providersMatch(stream.payee, bill.providerName)) ?? null;
}

function streamMeta(stream) {
  return {
    kind: stream.kind === 'subscription' ? 'subscription' : 'bill',
    cadence: stream.cadence,
    amountVaries: stream.fixedPrice === false,
    paymentMode: stream.kind === 'subscription' ? 'auto' : null,
  };
}

function trackedMeta(bill, stream) {
  const prefs = billPreferences(bill);
  const inferred = stream ? streamMeta(stream) : {};
  return {
    kind: inferred.kind ?? (bill.category === 'Subscriptions' ? 'subscription' : 'bill'),
    cadence: inferred.cadence ?? null,
    amountVaries: prefs.amountMode === 'variable'
      ? true
      : prefs.amountMode === 'fixed'
        ? false
        : Boolean(inferred.amountVaries),
    paymentMode: prefs.paymentMode ?? inferred.paymentMode ?? null,
  };
}

function recurringOccurrences(stream, month) {
  const rows = [];
  const meta = streamMeta(stream);
  const dates = stream.dates ?? [];
  const amounts = stream.amounts ?? [];

  for (let i = 0; i < dates.length; i += 1) {
    if (monthOf(dates[i]) !== month) continue;
    const amount = round(amounts[i] ?? stream.last_amount ?? stream.typical_amount);
    rows.push({
      id: `recurring:${stream.account_id ?? 'acct'}:${stream.payee}:${dates[i]}:${i}`,
      trackedBillId: null,
      providerName: stream.payee,
      category: stream.category ?? 'Other',
      source: 'bank',
      dueDate: dates[i],
      paidDate: dates[i],
      amountDue: amount,
      paidAmount: amount,
      paid: true,
      expected: false,
      ...meta,
    });
  }

  return rows;
}

/**
 * Conservative fallback for a variable bill.
 *
 * Amount matching is intentionally ignored only when the same provider appears
 * exactly once in the bill's month. Electric and water can move far more than
 * the generic 2% bill matcher permits; provider + month is strong enough when
 * there is only one candidate, while multiple candidates remain ambiguous.
 */
function findVariablePayment(bill, transactions) {
  const candidates = (transactions ?? []).filter((t) =>
    !t.is_transfer && !t.is_income && !t.pending && t.amount > 0
      && monthOf(t.posted_date) === monthOf(bill.dueDate)
      && providersMatch(t.payee, bill.providerName),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function paymentForTrackedBill(bill, transactions, amountVaries) {
  return findPayingTransaction(bill, transactions)
    ?? (amountVaries ? findVariablePayment(bill, transactions) : null);
}

function settledPayment(bill) {
  if (bill.status !== 'paid') return null;
  return {
    posted_date: String(bill.paidAt ?? bill.dueDate).slice(0, 10),
    amount: round(bill.paidAmount ?? bill.amountDue),
  };
}

/** Move a recurring date forward until it reaches the selected month. */
function firstOccurrenceInOrAfterMonth(stream, month) {
  let due = stream.next_expected;
  let guard = 0;
  while (due && monthOf(due) < month && guard++ < 120) {
    const next = projectNext(due, stream.cadence);
    if (!next || next <= due) return null;
    due = next;
  }
  return due;
}

/**
 * What was paid, and what is still due, in one calendar month.
 *
 * Recurring history supplies paid rows even when the tracked bill record has
 * already rolled forward to next month. Tracked bills supply unpaid rows even
 * before a bank transaction exists.
 */
export function buildBillMonth({
  bills = [], recurring = [], transactions = [], month,
} = {}) {
  if (!month) throw new Error('month is required');

  const actual = recurring.flatMap((stream) => recurringOccurrences(stream, month));
  const consumed = new Set();
  const rows = [];

  const trackedThisMonth = bills
    .filter((bill) => bill.status !== 'ignored' && monthOf(bill.dueDate) === month)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));

  for (const bill of trackedThisMonth) {
    const stream = matchingRecurringStream(bill, recurring);
    const meta = trackedMeta(bill, stream);

    // Prefer an observed recurring payment from the same provider and month.
    // If there are several (rare for a tracked bill), the one nearest the due
    // date is the only sensible candidate.
    const candidateIndexes = actual
      .map((row, index) => ({ row, index }))
      .filter(({ row, index }) => !consumed.has(index) && providersMatch(row.providerName, bill.providerName))
      .sort((a, b) => dayDistance(a.row.paidDate, bill.dueDate) - dayDistance(b.row.paidDate, bill.dueDate));

    let payment = settledPayment(bill);
    if (!payment && candidateIndexes.length && dayDistance(candidateIndexes[0].row.paidDate, bill.dueDate) <= 20) {
      const selected = candidateIndexes[0];
      consumed.add(selected.index);
      payment = {
        posted_date: selected.row.paidDate,
        amount: selected.row.paidAmount,
      };
    } else if (!payment) {
      payment = paymentForTrackedBill(bill, transactions, meta.amountVaries);
    }

    rows.push({
      id: `tracked:${bill.id ?? bill.providerKey ?? bill.providerName}:${bill.dueDate}`,
      trackedBillId: bill.id ?? null,
      providerName: bill.providerName,
      category: bill.category ?? stream?.category ?? 'Other',
      source: bill.source ?? 'manual',
      dueDate: bill.dueDate,
      paidDate: payment?.posted_date ?? null,
      amountDue: round(bill.amountDue),
      paidAmount: payment ? round(payment.amount) : 0,
      paid: Boolean(payment),
      expected: !payment,
      ...meta,
    });
  }

  // Actual recurring obligations that do not already correspond to a tracked
  // bill are still real money that left the account, so they belong here.
  actual.forEach((row, index) => {
    if (!consumed.has(index)) rows.push(row);
  });

  // Add recurring obligations that are expected later in the selected month.
  // Walk interval cadences so a weekly subscription can have more than one
  // remaining occurrence rather than only the next one. The first loop also
  // lets the month arrows look beyond the immediate next occurrence.
  for (const stream of recurring) {
    let due = firstOccurrenceInOrAfterMonth(stream, month);
    let guard = 0;
    while (due && monthOf(due) === month && guard++ < 8) {
      const trackedSameProvider = trackedThisMonth.some(
        (bill) => providersMatch(bill.providerName, stream.payee) && dayDistance(bill.dueDate, due) <= 20,
      );
      const alreadyActual = actual.some(
        (row) => providersMatch(row.providerName, stream.payee) && row.paidDate === due,
      );

      if (!trackedSameProvider && !alreadyActual) {
        rows.push({
          id: `expected:${stream.account_id ?? 'acct'}:${stream.payee}:${due}`,
          trackedBillId: null,
          providerName: stream.payee,
          category: stream.category ?? 'Other',
          source: 'bank',
          dueDate: due,
          paidDate: null,
          amountDue: round(stream.last_amount ?? stream.typical_amount),
          paidAmount: 0,
          paid: false,
          expected: true,
          ...streamMeta(stream),
        });
      }

      const next = projectNext(due, stream.cadence);
      if (!next || next <= due) break;
      due = next;
    }
  }

  rows.sort((a, b) => {
    const dateA = a.dueDate ?? a.paidDate ?? '';
    const dateB = b.dueDate ?? b.paidDate ?? '';
    return dateA.localeCompare(dateB) || a.providerName.localeCompare(b.providerName);
  });

  const paidTotal = round(rows.filter((r) => r.paid).reduce((sum, r) => sum + r.paidAmount, 0));
  const remaining = round(rows.filter((r) => !r.paid).reduce((sum, r) => sum + r.amountDue, 0));
  const total = round(paidTotal + remaining);

  return {
    month,
    rows,
    totals: {
      total,
      paid: paidTotal,
      remaining,
      paidCount: rows.filter((r) => r.paid).length,
      remainingCount: rows.filter((r) => !r.paid).length,
    },
  };
}

/**
 * Future obligations suitable for paycheck assignment.
 *
 * Tracked due dates win over a recurring projection for the same provider.
 * That matters for a mortgage known to be due on Sep 1 even if the bank's
 * posting rhythm projects Sep 3 from the prior charge.
 */
export function buildUpcomingObligations({
  bills = [], recurring = [], transactions = [], asOf,
} = {}) {
  const today = asOf ?? new Date().toISOString().slice(0, 10);
  const upcoming = [];

  const openTracked = bills.filter((bill) => {
    if (bill.status === 'paid' || bill.status === 'ignored') return false;
    const stream = matchingRecurringStream(bill, recurring);
    const meta = trackedMeta(bill, stream);
    return !paymentForTrackedBill(bill, transactions, meta.amountVaries);
  });

  for (const bill of openTracked) {
    const stream = matchingRecurringStream(bill, recurring);
    upcoming.push({
      ...bill,
      status: bill.status ?? 'confirmed',
      ...trackedMeta(bill, stream),
    });
  }

  for (const stream of recurring) {
    const dueDate = stream.next_expected;
    if (!dueDate || dueDate < today) continue;

    const represented = openTracked.some(
      (bill) => providersMatch(bill.providerName, stream.payee) && dayDistance(bill.dueDate, dueDate) <= 20,
    );
    if (represented) continue;

    upcoming.push({
      id: `recurring:${stream.account_id ?? 'acct'}:${stream.payee}:${dueDate}`,
      providerName: stream.payee,
      providerKey: stream.payee.toLowerCase(),
      category: stream.category ?? 'Other',
      amountDue: round(stream.last_amount ?? stream.typical_amount),
      dueDate,
      status: 'confirmed',
      source: 'bank',
      ...streamMeta(stream),
    });
  }

  return upcoming.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}
