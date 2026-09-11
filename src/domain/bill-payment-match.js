/**
 * Bill-to-transaction reconciliation.
 *
 * A bill detected from email or entered by hand sits in "upcoming" forever
 * unless something tells it the household already paid it through the
 * connected bank account — the other half of "smart about matching" bills
 * across sources: not just email vs. email, but email/manual vs. what
 * actually happened on the account.
 */
import { providersMatch } from './provider-match.js';

/** A bill can be paid up to a week early, including across month boundaries. */
const PAY_WINDOW_BEFORE_DUE_DAYS = 7;
/** ...or noticeably late, and still be this bill rather than a new one. */
const PAY_WINDOW_AFTER_DUE_DAYS = 14;
/** Amounts within this fraction are treated as the same figure. */
const AMOUNT_TOLERANCE = 0.02;

function daysBetween(fromIsoDate, toIsoDate) {
  return (Date.parse(String(toIsoDate) + 'T00:00:00Z')
    - Date.parse(String(fromIsoDate) + 'T00:00:00Z')) / 86400000;
}

function transactionDate(transaction) {
  return transaction?.posted_date || transaction?.date || transaction?.postedDate || null;
}

/**
 * Find the bank transaction that most likely paid a bill.
 *
 * Candidates must match provider, amount, and the date window. With more than
 * one matching candidate this returns null rather than guessing. A bill wrongly marked paid vanishes
 * from what's owed; a bill that stays visible one day too long is a far smaller
 * failure.
 *
 * @param {object} bill - a Bill (src/domain/bill.js shape): providerName, amountDue, dueDate
 * @param {object[]} transactions - raw transaction rows: payee, amount, posted_date,
 *   is_transfer, is_income, pending (Plaid sign convention: positive = money out)
 * @returns {object|null} the matching transaction, or null
 */
export function findPayingTransaction(bill, transactions) {
  const billAmount = Number(bill.amountDue);
  const candidates = (transactions ?? []).filter((t) => {
    if (t.is_transfer || t.is_income || t.pending || t.parent_transaction_id) return false;
    if (!providersMatch(t.payee || t.raw_description, bill.providerName)) return false;

    const transactionAmount = Number(t.amount);
    if (!Number.isFinite(transactionAmount) || transactionAmount <= 0) return false;

    const relative = billAmount ? Math.abs(transactionAmount - billAmount) / billAmount : 1;
    if (relative > AMOUNT_TOLERANCE) return false;
    // A documented or manually specified invoice is not an approximate target.
    // Even a small underpayment must remain open; fees/overpayments need review.
    const invoice = (bill.source && bill.source !== 'bank') || bill.verifiedAmount
      || bill.statementDate || bill.sourceDocumentId || bill.sourceMessageId;
    if (invoice && Math.round(transactionAmount * 100) !== Math.round(billAmount * 100)) return false;

    const paymentDate = transactionDate(t);
    if (!paymentDate) return false;
    const delta = daysBetween(bill.dueDate, paymentDate);
    return delta >= -PAY_WINDOW_BEFORE_DUE_DAYS && delta <= PAY_WINDOW_AFTER_DUE_DAYS;
  });

  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  const named = candidates.filter((t) => providersMatch(t.payee, bill.providerName));
  return named.length === 1 ? named[0] : null;
}
