/**
 * Categorize by resemblance to a payee the household already decided about.
 *
 * The layer this sits next to (learned rules) is exact-match on the cleaned
 * payee, deliberately: a human looked at one merchant and named it. But real
 * statements are full of near-misses that no human would call different
 * merchants — "SAFEWAY #1425", "SAFEWAY #0881", "SAFEWAY FUEL 22" — and
 * asking someone to categorize each of those separately is how a review queue
 * grows to a hundred rows nobody will ever work through.
 *
 * So: if an unknown payee shares its distinctive leading word with a payee the
 * household has already categorized, inherit that category. Recorded as its
 * own layer ('similar') rather than as 'learned', because it is an inference
 * about a human decision, not the decision itself — and one correction on the
 * original payee still re-flows through everything that inherited from it.
 *
 * The conservative bits, each of which exists to stop a wrong inheritance:
 *
 *   - Only the first token is matched, and only when it is distinctive
 *     (long enough, not a generic word like "the" or a bare store number).
 *   - A token that has been categorized inconsistently in the past — the same
 *     first word landing in two different categories — is skipped entirely.
 *     Ambiguity is exactly the case where guessing is worst.
 *   - Nothing here ever outranks a human, a household rule, a seed rule, or
 *     Plaid's own category. It only ever sees what those all passed on.
 */

/** Words too generic to identify a merchant on their own. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'for', 'to', 'inc', 'llc', 'ltd', 'co',
  'store', 'shop', 'market', 'online', 'payment', 'purchase', 'pos', 'debit',
  'credit', 'card', 'visa', 'sq', 'tst', 'www', 'com', 'usa', 'us',
]);

/** Below this a token is an abbreviation or a store number, not a name. */
const MIN_TOKEN_LENGTH = 4;

/**
 * The distinctive leading word of a payee, or null if it hasn't got one.
 * @param {string} payee
 */
export function payeeStem(payee) {
  if (!payee) return null;
  const first = String(payee)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .find((token) => !STOPWORDS.has(token) && !/^\d+$/.test(token));

  if (!first || first.length < MIN_TOKEN_LENGTH) return null;
  return first;
}

/**
 * Build stem -> category from transactions that already have a category.
 * A stem seen with more than one category is dropped: it identifies nothing.
 *
 * @param {Array<{payee: string, category: string|null}>} transactions
 * @returns {Map<string, string>}
 */
export function buildStemIndex(transactions) {
  const seen = new Map(); // stem -> Set of categories
  for (const txn of transactions) {
    if (!txn.category) continue;
    const stem = payeeStem(txn.payee);
    if (!stem) continue;
    if (!seen.has(stem)) seen.set(stem, new Set());
    seen.get(stem).add(txn.category);
  }

  const index = new Map();
  for (const [stem, categories] of seen) {
    if (categories.size === 1) index.set(stem, [...categories][0]);
  }
  return index;
}

/**
 * Category for an unknown payee, inherited from a similar known one.
 *
 * @param {string} payee
 * @param {Map<string, string>} stemIndex
 * @returns {string|null}
 */
export function categoryFromSimilarPayee(payee, stemIndex) {
  const stem = payeeStem(payee);
  if (!stem) return null;
  return stemIndex.get(stem) ?? null;
}
