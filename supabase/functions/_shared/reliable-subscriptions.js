// GENERATED FILE — do not edit.
// Source of truth: src/engine/reliable-subscriptions.js
// Regenerate with: npm run sync:shared
/**
 * Subscription streams safe enough to put on the Bills tab.
 *
 * Generic recurring detection answers "does this merchant appear on a rhythm?"
 * That is deliberately broad and is useful for analytics, but it is too broad
 * for an obligations screen: three Groupon purchases close together are not a
 * weekly bill, and extra Xbox purchases must not create extra subscriptions.
 *
 * This detector uses stronger evidence:
 *   - an explicit Subscriptions category, or recurring/autopay wording; OR
 *   - for entertainment/fitness/hobbies, the same price on a regular cadence
 *     at least three times.
 *
 * Provider aliases are merged on the same account ("Microsoft" and
 * "Microsoft Xbox") before cadence inference, so one real subscription stays
 * one stream even when the bank changes the merchant label.
 */
import { inferCadence, median, projectNext } from './cadence.js';
import { payeeStem } from './similar-payee.js';

const FALLBACK_CATEGORIES = new Set(['Entertainment', 'Fitness', 'Hobbies']);
const RECURRING_WORDS = /\b(recurring|recur|subscription|autopay|auto\s*pay)\b/i;
const PRICE_TOLERANCE = 0.02;

function round(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function outflows(transactions) {
  return (transactions ?? []).filter((t) =>
    !t.pending && !t.is_transfer && !t.is_income && Number(t.amount) > 0,
  );
}

function strongEvidence(t) {
  return t.category === 'Subscriptions' || RECURRING_WORDS.test(String(t.raw_description ?? ''));
}

function samePrice(a, b) {
  const left = Math.abs(Number(a));
  const right = Math.abs(Number(b));
  const base = Math.max(left, right, 1);
  return Math.abs(left - right) / base <= PRICE_TOLERANCE;
}

function aliasKey(payee) {
  return payeeStem(payee) ?? String(payee ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function groupAliases(transactions) {
  const groups = new Map();
  for (const txn of transactions) {
    const key = `${txn.account_id}::${aliasKey(txn.payee)}`;
    if (!groups.has(key)) groups.set(key, { account_id: txn.account_id, items: [] });
    groups.get(key).items.push(txn);
  }
  return [...groups.values()];
}

function bestFixedCluster(items) {
  const candidates = items.filter((t) => FALLBACK_CATEGORIES.has(t.category));
  const clusters = [];
  for (const item of candidates) {
    let cluster = clusters.find((c) => samePrice(c.anchor, item.amount));
    if (!cluster) {
      cluster = { anchor: item.amount, items: [] };
      clusters.push(cluster);
    }
    cluster.items.push(item);
  }

  return clusters
    .filter((c) => c.items.length >= 3)
    .map((c) => ({ ...c, cadence: inferCadence(c.items.map((t) => t.posted_date)) }))
    .filter((c) => c.cadence !== 'irregular')
    .sort((a, b) => b.items.length - a.items.length)[0] ?? null;
}

function displayName(items) {
  return [...new Set(items.map((t) => t.payee).filter(Boolean))]
    .sort((a, b) => b.length - a.length)[0] ?? 'Subscription';
}

function fixedPrice(amounts) {
  if (amounts.length < 2) return false;
  const mid = median(amounts);
  if (!mid) return false;
  return amounts.every((a) => Math.abs(a - mid) / mid <= PRICE_TOLERANCE);
}

/** @returns recurring-stream objects compatible with bill-center.js. */
export function buildReliableSubscriptionStreams(transactions = []) {
  const streams = [];

  for (const group of groupAliases(outflows(transactions))) {
    const strong = group.items.filter(strongEvidence);
    let chosen = null;
    let cadence = 'irregular';

    if (strong.length >= 2) {
      cadence = inferCadence(strong.map((t) => t.posted_date));
      if (cadence !== 'irregular') chosen = strong;
    }

    if (!chosen) {
      const fallback = bestFixedCluster(group.items);
      if (fallback) {
        chosen = fallback.items;
        cadence = fallback.cadence;
      }
    }

    if (!chosen) continue;

    const sorted = [...chosen].sort((a, b) => a.posted_date.localeCompare(b.posted_date));
    const dates = sorted.map((t) => t.posted_date);
    const amounts = sorted.map((t) => round(Math.abs(Number(t.amount))));
    const last = sorted.at(-1);

    streams.push({
      account_id: group.account_id,
      payee: displayName(sorted),
      category: 'Subscriptions',
      kind: 'subscription',
      cadence,
      fixedPrice: fixedPrice(amounts),
      typical_amount: round(median(amounts)),
      last_amount: amounts.at(-1),
      amounts,
      dates,
      occurrences: sorted.length,
      last_seen: last.posted_date,
      next_expected: projectNext(last.posted_date, cadence),
      confidence: sorted.length >= 3 ? 'high' : 'low',
    });
  }

  return streams.sort((a, b) => b.typical_amount - a.typical_amount);
}
