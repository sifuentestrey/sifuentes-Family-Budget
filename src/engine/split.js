/**
 * Splitting one charge across several categories.
 *
 * A $312 warehouse run is groceries and household goods and something for the
 * kids, and filing the whole thing under Groceries quietly inflates one
 * category every time it happens. The schema has always supported it — child
 * rows point at their parent, and the parent is excluded from every total —
 * but nothing could create the children.
 *
 * The rule that makes the arithmetic safe: **the parts must add up to the
 * parent exactly**. A split that loses a cent silently changes the month's
 * total, which is the one thing every screen in this app agrees on.
 */

const round = (n) => Math.round(n * 100) / 100;

/**
 * Which id a child points at.
 *
 * `parent_transaction_id` references `transactions.id` — the database uuid,
 * not Plaid's string id. Every exclusion check in the app used to compare it
 * against `plaid_transaction_id`, which never matches, so a split parent
 * would have been counted alongside its own children. Both are checked here
 * so there is one answer to "is this a parent" and the call sites can't drift
 * apart again.
 */
export function isSplitParent(txn, parentIds) {
  if (!parentIds?.size) return false;
  return parentIds.has(txn.id) || parentIds.has(txn.plaid_transaction_id);
}

/** The set of ids that are a parent of some split, from a transaction list. */
export function splitParentIds(transactions) {
  return new Set((transactions ?? []).map((t) => t.parent_transaction_id).filter(Boolean));
}

/**
 * Validate a proposed split and produce the child rows.
 *
 * @param {object} parent - the transaction being split
 * @param {{amount: number|string, category: string|null}[]} parts
 * @returns {{ok: true, children: object[]} | {ok: false, error: string}}
 */
export function planSplit(parent, parts) {
  const total = round(Math.abs(Number(parent?.amount) || 0));
  if (!total) return { ok: false, error: 'This transaction has no amount to split.' };

  const cleaned = (parts ?? [])
    .map((p) => ({ amount: round(Number(p.amount) || 0), category: p.category || null }))
    .filter((p) => p.amount > 0);

  if (!cleaned.length) {
    return { ok: false, error: `Put an amount against at least two categories, adding up to ${money(total)}.` };
  }

  // The remainder is checked before the count, because "you have $65
  // unassigned" is what the household can act on. Being told a split needs
  // two parts, when they have typed one and left the other blank, describes
  // the form rather than the problem.
  const sum = round(cleaned.reduce((s, p) => s + p.amount, 0));
  if (sum !== total) {
    const diff = round(total - sum);
    return {
      ok: false,
      error: diff > 0
        ? `${money(diff)} is unassigned — the parts have to add up to ${money(total)}.`
        : `That is ${money(-diff)} more than the ${money(total)} charge.`,
    };
  }

  if (cleaned.length < 2) {
    return { ok: false, error: 'A split needs at least two parts — otherwise just change the category.' };
  }

  return {
    ok: true,
    children: cleaned.map((p) => ({
      household_id: parent.household_id,
      account_id: parent.account_id,
      parent_transaction_id: parent.id,
      posted_date: parent.posted_date,
      // Sign follows the parent, so a refund split stays a refund.
      amount: parent.amount < 0 ? -p.amount : p.amount,
      payee: parent.payee,
      raw_description: parent.raw_description ?? parent.payee,
      category: p.category,
      // A split is a human decision about where money went, so the automated
      // layers must never revisit it.
      manually_categorized: true,
      categorized_by: 'split',
      is_transfer: false,
      is_income: false,
      pending: false,
    })),
  };
}

function money(n) {
  return `$${Math.abs(n).toFixed(2)}`;
}
