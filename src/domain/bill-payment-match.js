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

/** A bill can be paid a little early. */
const PAY_WINDOW_BEFORE_DUE_DAYS = 3;
/** ...or noticeably late, and still be this bill rather than a new one. */
const PAY_WINDOW_AFTER_DUE_DAYS = 14;
/** Amounts within this fraction are treated as the same figure. */
const AMOUNT_TOLERANCE = 0.02;

function daysBetween(fromIsoDate, toIsoDate) {
  return (Date.parse(`${toIsoDate}T00:00:00Z`) - Date.parse(`${fromIsoDate}T00:00:00Z`)) / 86400000;
}

/**
 * Find the bank transaction that most likely paid a bill.
 *
 * Deliberately conservative: candidates are the transactions matching on
 * amount and date window alone. If more than one qualifies, only the
 * provider name breaks the tie — with none or more than one naming the
 * bill's provider, this returns null rather than guessing. A bill wrongly
 * marked paid vanishes from what's owed; a bill that stays visible one day
 * too long is a far smaller failure.
 *
 * @param {object} bill - a Bill (src/domain/bill.js shape): providerName, amountDue, dueDate
 * @param {object[]} transactions - raw transaction rows: payee, amount, posted_date,
 *   is_transfer, is_income, pending (Plaid sign convention: positive = money out)
 * @returns {object|null} the matching transaction, or null
 */
export function findPayingTransaction(bill, transactions) {
  const candidates = (transactions ?? []).filter((t) => {
    if (t.is_transfer || t.is_income || t.pending) return false;
    if (!(t.amount > 0)) return false;

    const relative = bill.amountDue ? Math.abs(t.amount - bill.amountDue) / bill.amountDue : 1;
    if (relative > AMOUNT_TOLERANCE) return false;

    const delta = daysBetween(bill.dueDate, t.posted_date);
    return delta >= -PAY_WINDOW_BEFORE_DUE_DAYS && delta <= PAY_WINDOW_AFTER_DUE_DAYS;
  });

  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  const named = candidates.filter((t) => providersMatch(t.payee, bill.providerName));
  return named.length === 1 ? named[0] : null;
}
