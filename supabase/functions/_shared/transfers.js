// GENERATED FILE — do not edit.
// Source of truth: src/engine/transfers.js
// Regenerate with: npm run sync:shared
/**
 * Transfer detection.
 *
 * This is the single most consequential piece of logic in the app.
 *
 * When you pay a credit card, two transactions exist: money leaves checking,
 * and the card balance drops. Neither is spending — the spending already
 * happened at the swipe, and was already counted then. A tool that treats the
 * card payment as an expense inflates monthly spend by the full amount paid to
 * the cards, every month. For a household paying off $2,000/mo in card
 * balances, the budget is wrong by $2,000 and every trend built on it is junk.
 *
 * The same applies to checking -> savings moves, which are saving, not spending.
 *
 * Detection: a debit in one account and a credit in another, equal magnitude,
 * within a few days. Real transfers post on slightly different days, hence the
 * window.
 */

import { isSplitParent } from './split.js';

const DEFAULT_WINDOW_DAYS = 4;
/** Tolerance for amount matching, in dollars. Transfers are exact; this guards float noise. */
const AMOUNT_EPSILON = 0.005;

function daysBetween(a, b) {
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return ms / 86400000;
}

/**
 * Keywords that mark an obvious transfer even without a visible counterpart.
 * Needed because the other side may live at an institution that isn't linked —
 * paying a card the household hasn't connected still must not count as spending.
 */
const TRANSFER_HINTS = [
  'autopay', 'auto pay', 'card payment', 'credit crd', 'crd autopay',
  'payment thank you', 'payment - thank you', 'online transfer',
  'transfer to', 'transfer from', 'internal transfer', 'ach transfer',
  'epay', 'e-payment', 'bill pay', 'zelle', 'venmo cashout',
  'to savings', 'from savings', 'to checking', 'from checking',
];

/**
 * Plaid's own verdict, which is better than any keyword list we can write.
 *
 * TRANSFER_IN / TRANSFER_OUT covers the case that started this: money moved
 * to a brokerage or retirement account. That is not spending — it is the
 * household's own money changing shelves — but with the counterpart account
 * unlinked there is nothing to pair it with, no keyword in "FIDELITY", and so
 * it was landing in the spending total. Worse, it then got a category from
 * whatever layer guessed hardest; the one that prompted this was filed under
 * Dining Out.
 *
 * Credit card payments are classified by Plaid under LOAN_PAYMENTS rather
 * than TRANSFER_OUT, so that one detail is named explicitly. The rest of
 * LOAN_PAYMENTS — a car loan, a student loan, a mortgage — genuinely is
 * money leaving the household, so it must not be swept in here.
 */
const PFC_TRANSFER_PRIMARIES = new Set(['TRANSFER_IN', 'TRANSFER_OUT']);
const PFC_TRANSFER_DETAILED = new Set([
  'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
  'TRANSFER_OUT_ACCOUNT_TRANSFER',
  'TRANSFER_IN_ACCOUNT_TRANSFER',
  'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS',
  'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS',
  'TRANSFER_OUT_SAVINGS',
  'TRANSFER_IN_SAVINGS',
]);

export function isPlaidTransfer(txn) {
  const pfc = txn?.plaidCategory
    ?? (txn?.pfc_primary || txn?.pfc_detailed
      ? { primary: txn.pfc_primary ?? null, detailed: txn.pfc_detailed ?? null }
      : null);
  if (!pfc) return false;
  if (!(txn.amount > 0)) return false;
  if (pfc.detailed && PFC_TRANSFER_DETAILED.has(pfc.detailed)) return true;
  return Boolean(pfc.primary && PFC_TRANSFER_PRIMARIES.has(pfc.primary));
}

function looksLikeTransfer(txn) {
  if (isPlaidTransfer(txn)) return true;
  const text = `${txn.payee} ${txn.raw_description}`.toLowerCase();
  return TRANSFER_HINTS.some((hint) => text.includes(hint));
}

/**
 * Find transfer pairs and flag both sides.
 *
 * Matching is greedy and one-to-one: each transaction can pair at most once, so
 * three $500 moves in a week produce three distinct pairs rather than a tangle.
 * Candidates are sorted by date distance so the nearest counterpart wins — with
 * several identical amounts in flight, the closest pair is the right one.
 *
 * `transfer_pair_id` is a Postgres foreign key to transactions.id (UUID). Plaid
 * transaction IDs are external strings and must never be written there. Pure
 * in-memory fixtures often do not have database UUIDs yet; those pairs are still
 * flagged as transfers, but their pair id remains null until the rows exist in
 * storage.
 *
 * @param {Array<object>} transactions - must span all accounts to pair correctly
 * @param {object} [opts]
 * @param {number} [opts.windowDays=4]
 * @returns {Array<object>} transactions with is_transfer / transfer_pair_id set
 */
export function detectTransfers(transactions, opts = {}) {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const result = transactions.map((t) => ({ ...t }));
  const paired = new Set();

  const byAmount = new Map();
  for (let i = 0; i < result.length; i++) {
    const key = Math.abs(result[i].amount).toFixed(2);
    if (!byAmount.has(key)) byAmount.set(key, []);
    byAmount.get(key).push(i);
  }

  for (let i = 0; i < result.length; i++) {
    if (paired.has(i)) continue;
    const txn = result[i];
    if (txn.amount <= 0) continue;

    const candidates = (byAmount.get(Math.abs(txn.amount).toFixed(2)) || [])
      .filter((j) => {
        if (j === i || paired.has(j)) return false;
        const other = result[j];
        return (
          other.amount < 0 &&
          other.account_id !== txn.account_id &&
          Math.abs(Math.abs(other.amount) - txn.amount) < AMOUNT_EPSILON &&
          daysBetween(txn.posted_date, other.posted_date) <= windowDays
        );
      })
      .sort(
        (a, b) =>
          daysBetween(txn.posted_date, result[a].posted_date) -
          daysBetween(txn.posted_date, result[b].posted_date),
      );

    if (candidates.length > 0) {
      const j = candidates[0];
      result[i].is_transfer = true;
      result[j].is_transfer = true;
      result[i].transfer_pair_id = result[j].id ?? null;
      result[j].transfer_pair_id = result[i].id ?? null;
      paired.add(i);
      paired.add(j);
    }
  }

  for (let i = 0; i < result.length; i++) {
    if (!result[i].is_transfer && looksLikeTransfer(result[i])) {
      result[i].is_transfer = true;
    }
  }

  return result;
}

export function totalSpending(transactions) {
  const parentIds = new Set(
    transactions.map((t) => t.parent_transaction_id).filter(Boolean),
  );
  return transactions
    .filter(
      (t) =>
        !t.is_transfer &&
        !t.is_income &&
        !t.pending &&
        t.amount > 0 &&
        !isSplitParent(t, parentIds),
    )
    .reduce((sum, t) => sum + t.amount, 0);
}
