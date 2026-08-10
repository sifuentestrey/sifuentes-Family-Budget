/**
 * Layered categorization.
 *
 * Why layered rather than pure-rules or pure-AI:
 *
 *   Pure rules miss every merchant nobody anticipated. There is always a new
 *   one, so coverage stays permanently incomplete.
 *
 *   Pure LLM is non-deterministic. The same charge can land in different
 *   categories across runs, so monthly totals shift with no underlying change
 *   in spending and nobody can explain a number. For a budget two people make
 *   decisions from, that is disqualifying.
 *
 * So: deterministic layers decide everything they can, AI only ever sees the
 * residue, and a human decision always outranks a machine one. Every result
 * records which layer produced it, so any category can be explained.
 *
 * Precedence (first match wins):
 *   1. learned    - a human corrected this payee before. Absolute.
 *   2. rule       - household keyword rules, then seed keyword rules.
 *   3. plaid_pfc  - Plaid's own ML category.
 *   4. llm        - optional, off by default, unknown payees only.
 *   5. none       - Uncategorized, surfaced in the review queue.
 */

import { cleanPayee, payeeKey } from './normalize.js';
import { SEED_RULES, PFC_DETAILED_MAP, PFC_PRIMARY_MAP } from './seed-rules.js';

/** @typedef {{category: string|null, by: 'learned'|'rule'|'plaid_pfc'|'llm'|'none'}} Decision */

/**
 * Build a fast lookup of learned rules keyed by normalized payee.
 * Learned rules are exact-match on the cleaned payee: they were created by a
 * human looking at a specific merchant, so widening them to substring matches
 * would apply a decision more broadly than the human intended.
 *
 * @param {Array<{pattern: string, category: string, is_learned: boolean}>} rules
 */
export function buildLearnedIndex(rules) {
  const index = new Map();
  for (const rule of rules) {
    if (rule.is_learned) index.set(payeeKey(rule.pattern), rule.category);
  }
  return index;
}

/**
 * Match a payee against keyword rules (substring, case-insensitive).
 * Longer patterns are tried first so "whole foods" beats a generic "food".
 *
 * @param {string} payee - cleaned payee
 * @param {Array<[string, string]>} rules - [pattern, category] pairs
 */
export function matchKeywordRules(payee, rules) {
  const haystack = payee.toLowerCase();
  let best = null;
  let bestLength = 0;
  for (const [pattern, category] of rules) {
    if (pattern.length > bestLength && haystack.includes(pattern.toLowerCase())) {
      best = category;
      bestLength = pattern.length;
    }
  }
  return best;
}

/**
 * Map a Plaid personal_finance_category onto our taxonomy.
 * Detailed first (more precise), then primary as a fallback.
 *
 * @param {{primary?: string, detailed?: string}|null} pfc
 */
export function matchPlaidCategory(pfc) {
  if (!pfc) return null;
  if (pfc.detailed && PFC_DETAILED_MAP[pfc.detailed]) return PFC_DETAILED_MAP[pfc.detailed];
  if (pfc.primary && PFC_PRIMARY_MAP[pfc.primary]) return PFC_PRIMARY_MAP[pfc.primary];
  return null;
}

/**
 * Decide a category for one transaction.
 *
 * @param {object} txn - normalized transaction ({payee, plaidCategory})
 * @param {object} ctx
 * @param {Map<string,string>} ctx.learned - payeeKey -> category
 * @param {Array<[string,string]>} [ctx.householdRules] - user's own keyword rules
 * @returns {Decision}
 */
export function categorizeOne(txn, ctx) {
  const payee = txn.payee;

  // 1. Human decision. Never overridden by anything below.
  const learned = ctx.learned?.get(payeeKey(payee));
  if (learned) return { category: learned, by: 'learned' };

  // 2. Household-specific rules outrank the shipped defaults — they encode
  //    knowledge no vendor has (a named Venmo recipient who is really daycare).
  if (ctx.householdRules?.length) {
    const hit = matchKeywordRules(payee, ctx.householdRules);
    if (hit) return { category: hit, by: 'rule' };
  }

  // 3. Seed keyword rules.
  const seedHit = matchKeywordRules(payee, SEED_RULES);
  if (seedHit) return { category: seedHit, by: 'rule' };

  // 4. Plaid's ML category.
  const pfcHit = matchPlaidCategory(txn.plaidCategory);
  if (pfcHit) return { category: pfcHit, by: 'plaid_pfc' };

  // 5. Give up loudly, not silently. Uncategorized rows go to the review queue
  //    where a single correction becomes a permanent learned rule.
  return { category: null, by: 'none' };
}

/**
 * Categorize a batch.
 *
 * Rows already marked `manually_categorized` are returned untouched — this is
 * the guarantee that a re-sync never undoes a human's correction.
 *
 * @param {Array<object>} transactions
 * @param {object} ctx - see categorizeOne
 * @returns {Array<object>} transactions with {category, categorized_by} set
 */
export function categorizeBatch(transactions, ctx) {
  return transactions.map((txn) => {
    if (txn.manually_categorized) return txn;
    const decision = categorizeOne(txn, ctx);
    return { ...txn, category: decision.category, categorized_by: decision.by };
  });
}

/**
 * Normalize a raw Plaid transaction into our shape.
 *
 * Sign convention: Plaid uses positive for money out. We keep that rather than
 * flipping it — a translation layer is exactly where sign bugs breed, and every
 * downstream total would need to agree on the flip.
 */
export function normalizePlaidTransaction(raw, accountId) {
  return {
    plaid_transaction_id: raw.transaction_id,
    account_id: accountId,
    posted_date: raw.date,
    amount: raw.amount,
    raw_description: raw.original_description || raw.name || '',
    payee: cleanPayee(raw.name, raw.merchant_name),
    plaidCategory: raw.personal_finance_category || null,
    pending: Boolean(raw.pending),
    manually_categorized: false,
    category: null,
    categorized_by: 'none',
    is_transfer: false,
    is_income: false,
  };
}

/**
 * Report per-layer hit rate. Used to tune seed rules against fixtures before
 * real data lands, and to show the user how much of their spending is being
 * categorized without them having to intervene.
 */
export function categorizationStats(transactions) {
  const counts = { learned: 0, rule: 0, plaid_pfc: 0, llm: 0, none: 0 };
  for (const txn of transactions) {
    counts[txn.categorized_by] = (counts[txn.categorized_by] || 0) + 1;
  }
  const total = transactions.length || 1;
  return {
    counts,
    total: transactions.length,
    coverage: Number((((total - counts.none) / total) * 100).toFixed(1)),
  };
}
