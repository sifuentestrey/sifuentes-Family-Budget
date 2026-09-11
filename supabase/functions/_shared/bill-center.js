// GENERATED FILE — do not edit.
// Source of truth: src/engine/bill-center.js
// Regenerate with: npm run sync:shared
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

import { findPayingTransaction } from './domain/bill-payment-match.js';
import { providersMatch } from './domain/provider-match.js';
import { projectNext } from './cadence.js';
import { payeeStem } from './similar-payee.js';

const round = (n) => Math.round(Number(n || 0) * 100) / 100;
const monthOf = (date) => String(date ?? '').slice(0, 7);

function dayDistance(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs((Date.parse(String(a) + 'T00:00:00Z') - Date.parse(String(b) + 'T00:00:00Z')) / 86400000);
}

function dateDelta(from, to) {
  if (!from || !to) return Infinity;
  return (Date.parse(String(to) + 'T00:00:00Z')
    - Date.parse(String(from) + 'T00:00:00Z')) / 86400000;
}

function transactionDate(transaction) {
  return transaction?.posted_date || transaction?.date || transaction?.postedDate || null;
}

/**
 * Bill-provider matching is intentionally a little more forgiving than the
 * generic provider matcher. ACH loan descriptors are often much longer than
 * the household-facing name: "Advancial Auto Loan" vs
 * "Advancial Fed Cu DES:Loan Pymt ...". Their distinctive first token is the
 * same provider, and treating them as unrelated creates a duplicate bill.
 */
export function obligationProvidersMatch(a, b) {
  if (providersMatch(a, b)) return true;
  const stemA = payeeStem(a);
  const stemB = payeeStem(b);
  return Boolean(stemA && stemB && stemA === stemB);
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
  return recurring.find((stream) => obligationProvidersMatch(stream.payee, bill.providerName)) ?? null;
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
  const meta = streamMeta(stream);
  const dates = stream.dates ?? [];
  const amounts = stream.amounts ?? [];
  const byDate = new Map();

  // A bank feed can contain two same-provider charges on the same day. On the
  // Bills screen that should read as one provider row with the amount that
  // actually left the account, not as two visually duplicated bills.
  for (let i = 0; i < dates.length; i += 1) {
    if (monthOf(dates[i]) !== month) continue;
    const amount = round(amounts[i] ?? stream.last_amount ?? stream.typical_amount);
    const existing = byDate.get(dates[i]) ?? { amount: 0, count: 0 };
    existing.amount = round(existing.amount + amount);
    existing.count += 1;
    byDate.set(dates[i], existing);
  }

  return [...byDate.entries()].map(([date, occurrence]) => ({
    id: `recurring:${stream.account_id ?? 'acct'}:${stream.payee}:${date}`,
    trackedBillId: null,
    providerName: stream.payee,
    category: stream.category ?? 'Other',
    source: 'bank',
    dueDate: date,
    paidDate: date,
    amountDue: occurrence.amount,
    paidAmount: occurrence.amount,
    paid: true,
    expected: false,
    occurrenceCount: occurrence.count,
    ...meta,
  }));
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
  const candidates = (transactions ?? []).filter((t) => {
    if (t.is_transfer || t.is_income || t.pending || t.parent_transaction_id || Number(t.amount) <= 0) return false;
    const paymentDate = transactionDate(t);
    const delta = dateDelta(bill.dueDate, paymentDate);
    return delta >= -7 && delta <= 14
      && obligationProvidersMatch(t.payee, bill.providerName);
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function paymentForTrackedBill(bill, transactions, amountVaries) {
  return findPayingTransaction(bill, transactions)
    // Only a bank-derived estimate can be replaced by a different payment
    // amount. A real invoice must not be settled by a partial payment.
    ?? (amountVaries && bill.source === 'bank' && !bill.verifiedAmount
      && !bill.statementDate && !bill.sourceDocumentId && !bill.sourceMessageId
      ? findVariablePayment(bill, transactions) : null);
}

function settledPayment(bill, transactions = []) {
  if (bill.status !== 'paid') return null;
  // Old reconciliation could link an equal-sized charge from another provider.
  // When the linked bank row is available, validate it instead of trusting the
  // saved status. Missing history alone does not undo a confirmed payment.
  const linked = transactions.find(t => t.id && t.id === bill.paidTransactionId);
  if (linked) {
    if (linked.pending || linked.is_transfer || linked.is_income
        || linked.parent_transaction_id || !(Number(linked.amount) > 0)
        || !obligationProvidersMatch(linked.payee || linked.raw_description, bill.providerName)) return null;
    return linked;
  }
  return {
    posted_date: String(bill.paidAt ?? bill.dueDate).slice(0, 10),
    amount: round(bill.paidAmount ?? bill.amountDue),
  };
}

/**
 * Reconcile a tracked bill against the bank before a planning screen uses it.
 *
 * This keeps "paid" as an observed fact on the view model without mutating the
 * household's bill row. A bill may be paid early or late, so its due date
 * remains the date used for future planning while paidDate records what the
 * bank actually shows.
 */
export function reconcileTrackedBill(bill, transactions = [], recurring = []) {
  const stream = matchingRecurringStream(bill, recurring);
  const meta = trackedMeta(bill, stream);
  const payment = settledPayment(bill, transactions)
    ?? paymentForTrackedBill(bill, transactions, meta.amountVaries);
  const paid = Boolean(payment);
  const paidDate = payment ? transactionDate(payment) : null;

  return {
    ...bill,
    ...meta,
    status: paid ? 'paid' : bill.status === 'paid' ? 'confirmed' : bill.status,
    needsReview: bill.needsReview || (bill.status === 'paid' && !paid),
    amountDue: round(bill.amountDue),
    paid,
    expected: !paid,
    paidDate: paidDate ?? null,
    paidAmount: paid ? round(payment.amount) : 0,
    paidTransactionId: payment?.id ?? bill.paidTransactionId ?? null,
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

    const availableTransactions = transactions.filter(t => !consumed.has(`tx:${t.id || t.plaid_transaction_id}`));
    let payment = settledPayment(bill, transactions) ?? paymentForTrackedBill(bill, availableTransactions, meta.amountVaries);
    // Recurring fixtures can supply evidence when the raw feed is unavailable.
    if (!payment && !transactions.length) {
      const candidates = actual.map((r, index) => ({ ...r, id: `rec:${index}`, payee: r.providerName,
        amount: r.paidAmount, posted_date: r.paidDate })).filter(r => !consumed.has(Number(r.id.slice(4))));
      payment = paymentForTrackedBill(bill, candidates, meta.amountVaries);
    }
    if (payment) {
      consumed.add(`tx:${payment.id || payment.plaid_transaction_id}`);
      actual.forEach((r, index) => {
        if (obligationProvidersMatch(r.providerName, bill.providerName) && r.paidDate === transactionDate(payment)
            && Math.abs(r.paidAmount - Number(payment.amount)) < 0.01) consumed.add(index);
      });
    }

    rows.push({
      id: `tracked:${bill.id ?? bill.providerKey ?? bill.providerName}:${bill.dueDate}`,
      trackedBillId: bill.id ?? null,
      providerName: bill.providerName,
      category: bill.category ?? stream?.category ?? 'Other',
      source: bill.source ?? 'manual',
      dueDate: bill.dueDate,
      paidDate: payment ? transactionDate(payment) : null,
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
    const belongsToAnotherMonth = bills.some(b => b.status !== 'ignored' && monthOf(b.dueDate) !== month
      && obligationProvidersMatch(row.providerName, b.providerName)
      && transactionDate(paymentForTrackedBill(b, transactions, trackedMeta(b, matchingRecurringStream(b, recurring)).amountVaries)) === row.paidDate);
    if (!consumed.has(index) && !belongsToAnotherMonth) rows.push(row);
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
        (bill) => obligationProvidersMatch(bill.providerName, stream.payee) && dayDistance(bill.dueDate, due) <= 20,
      );
      const alreadyActual = actual.some(
        (row) => obligationProvidersMatch(row.providerName, stream.payee) && row.paidDate === due,
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
    if (bill.status === 'ignored') return false;
    return !reconcileTrackedBill(bill, transactions, recurring).paid;
  });

  for (const bill of openTracked) {
    const stream = matchingRecurringStream(bill, recurring);
    upcoming.push({
      ...reconcileTrackedBill(bill, transactions, recurring),
      ...trackedMeta(bill, stream),
    });
  }

  for (const stream of recurring) {
    const dueDate = stream.next_expected;
    if (!dueDate || dueDate < today) continue;

    const represented = bills.some(
      (bill) => obligationProvidersMatch(bill.providerName, stream.payee) && dayDistance(bill.dueDate, dueDate) <= 20,
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
