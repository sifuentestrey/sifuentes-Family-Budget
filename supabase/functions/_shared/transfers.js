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
 * Detection is deliberately conservative. Equal and opposite amounts across
 * accounts are only a candidate pair; they need transfer evidence or a very
 * narrow same-day fallback. Otherwise two unrelated person-to-person payments
 * can get paired simply because their amounts happen to match.
 */

import { isSplitParent } from './split.js';

const DEFAULT_WINDOW_DAYS = 4;
/** Tolerance for amount matching, in dollars. Transfers are exact; this guards float noise. */
const AMOUNT_EPSILON = 0.005;
/** Same-day unlabeled pairs below this are too easy to confuse with P2P activity. */
const UNLABELED_SAME_DAY_MIN = 50;

function daysBetween(a, b) {
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return ms / 86400000;
}

/**
 * High-specificity text hints for money moving between the household's own
 * accounts or paying a linked/unlinked credit card.
 *
 * Do NOT put generic payment rails here. "Zelle", "bill pay", or "autopay"
 * alone say nothing about ownership of the destination — they can be ordinary
 * spending. A false transfer is worse than an unrecognized one because it
 * silently removes real spending from every budget view.
 */
const TRANSFER_HINTS = [
  'card payment', 'credit crd', 'crd autopay',
  'payment thank you', 'payment - thank you',
  'online banking transfer', 'online transfer',
  'transfer to', 'transfer from', 'internal transfer',
  'epay', 'e-payment', 'epayment',
  'venmo cashout',
  'to savings', 'from savings', 'to checking', 'from checking',
  'overdraft protection',
];

/**
 * Plaid's own verdict, which is better than any keyword list we can write.
 *
 * TRANSFER_IN / TRANSFER_OUT covers money moved to another owned account such
 * as savings, brokerage, or retirement. Credit-card payments are classified by
 * Plaid under LOAN_PAYMENTS, so that one detailed category is named explicitly.
 * The rest of LOAN_PAYMENTS — car loan, student loan, mortgage — genuinely is
 * money leaving the household and must not be swept in here.
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
  // Nested in memory, two flat columns once read back from the database.
  const pfc = txn?.plaidCategory
    ?? (txn?.pfc_primary || txn?.pfc_detailed
      ? { primary: txn.pfc_primary ?? null, detailed: txn.pfc_detailed ?? null }
      : null);
  if (!pfc) return false;

  // Outflows only. A deposit Plaid labels TRANSFER_IN is sometimes payroll
  // routed through a processor. The deposit side of a genuine internal transfer
  // can be paired against its evidenced outflow, so declining to guess here
  // protects income without losing real account-to-account moves.
  if (!(txn.amount > 0)) return false;

  if (pfc.detailed && PFC_TRANSFER_DETAILED.has(pfc.detailed)) return true;
  return Boolean(pfc.primary && PFC_TRANSFER_PRIMARIES.has(pfc.primary));
}

function transferText(txn) {
  return `${txn?.payee ?? ''} ${txn?.raw_description ?? ''}`.toLowerCase().trim();
}

export function hasTransferEvidence(txn) {
  if (isPlaidTransfer(txn)) return true;
  const text = transferText(txn);
  // Some providers/fixtures literally return only "Transfer". That is strong
  // enough when it is the whole descriptor, but we deliberately do not match
  // arbitrary phrases containing the word.
  if (/^transfer(?:\s+transfer)?$/.test(text)) return true;
  return TRANSFER_HINTS.some((hint) => text.includes(hint));
}

function hasPairEvidence(outflow, inflow) {
  if (hasTransferEvidence(outflow) || hasTransferEvidence(inflow)) return true;
  // A large equal-and-opposite movement on the exact same posting day across
  // owned linked accounts is strong enough even when a provider omitted labels.
  // Keeping this same-day and >= $50 avoids the live $10 P2P false-pair case.
  return daysBetween(outflow.posted_date, inflow.posted_date) === 0
    && Math.abs(Number(outflow.amount)) >= UNLABELED_SAME_DAY_MIN;
}

/**
 * Find transfer pairs and flag both sides.
 *
 * Matching is greedy and one-to-one. Each candidate must have equal magnitude,
 * be in a different account, land within the date window, AND have transfer
 * evidence on at least one side (or meet the strict same-day fallback). This
 * prevents unrelated person-to-person inflows/outflows from canceling each
 * other out of spending.
 *
 * `transfer_pair_id` is a Postgres foreign key to transactions.id (UUID). Plaid
 * transaction IDs are external strings and must never be written there. Pure
 * in-memory fixtures often do not have database UUIDs yet; those pairs are still
 * flagged as transfers, but their pair id remains null until the rows exist in
 * storage.
 *
 * Reprocessing starts stale positives from a clean transfer state. Transactions
 * that never had a transfer verdict keep their original shape, which avoids
 * changing unrelated engine contracts from `undefined` to `false`. Database
 * rows that were previously marked `true`, however, are explicitly reset so an
 * old false-positive can heal when the rules improve.
 *
 * @param {Array<object>} transactions - must span all accounts to pair correctly
 * @param {object} [opts]
 * @param {number} [opts.windowDays=4]
 * @returns {Array<object>} transactions with is_transfer / transfer_pair_id set
 */
export function detectTransfers(transactions, opts = {}) {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const result = transactions.map((t) => {
    const copy = { ...t, transfer_pair_id: null };
    if (t.is_transfer === true) copy.is_transfer = false;
    return copy;
  });
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
    // Only start from the outflow side, so each pair is considered once.
    if (txn.amount <= 0) continue;

    const candidates = (byAmount.get(Math.abs(txn.amount).toFixed(2)) || [])
      .filter((j) => {
        if (j === i || paired.has(j)) return false;
        const other = result[j];
        return (
          other.amount < 0 &&
          other.account_id !== txn.account_id &&
          Math.abs(Math.abs(other.amount) - txn.amount) < AMOUNT_EPSILON &&
          daysBetween(txn.posted_date, other.posted_date) <= windowDays &&
          hasPairEvidence(txn, other)
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

  // Unpaired but strongly evidenced transfers are still excluded. This covers
  // card payments or owned-account moves whose counterpart account is unlinked.
  for (let i = 0; i < result.length; i++) {
    if (!result[i].is_transfer && hasTransferEvidence(result[i])) {
      result[i].is_transfer = true;
    }
  }

  return result;
}

/**
 * Sum spending, applying every exclusion that matters.
 *
 * Kept here rather than inline at call sites so there is exactly one definition
 * of "spending" in the codebase. Divergent definitions across views is how a
 * dashboard ends up disagreeing with its own detail page.
 */
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
