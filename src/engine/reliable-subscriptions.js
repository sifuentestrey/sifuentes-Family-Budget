/**
 * Subscription streams safe enough to put on the Bills tab.
 *
 * Generic recurring detection answers "does this merchant appear on a rhythm?"
 * That is deliberately broad and useful for analytics, but it is too broad for
 * an obligations screen. One merchant can sell several unrelated things
 * (Apple/Google), and duplicate same-day charges can make a monthly service look
 * semi-monthly if the dates are fed to cadence inference unchanged.
 *
 * This detector therefore asks a stricter question: "is there one stable price
 * cluster from this provider that repeats on a real cadence?" The most recent
 * qualifying cluster wins. That keeps a current subscription after a price
 * change while refusing to combine unrelated purchases into one fake stream.
 */
import { addDays, inferCadence, median, projectNext } from './cadence.js';
import { payeeStem } from './similar-payee.js';

const FALLBACK_CATEGORIES = new Set(['Entertainment', 'Fitness', 'Hobbies']);
const RECURRING_WORDS = /\b(recurring|recur|subscription|autopay|auto\s*pay)\b/i;
const PRICE_TOLERANCE = 0.02;
// One late/missed monthly charge is not enough to declare something cancelled.
// After three weeks past the expected date, however, it should stop being
// presented as money that definitely NEEDS to leave the account.
const DEFAULT_MISSED_GRACE_DAYS = 21;

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

/**
 * Same provider, same date, same amount is one CADENCE observation.
 *
 * The bank can expose two Google charges that post on the same day. They may
 * represent two products, but they emphatically do not mean the household pays
 * Google twice a month. We dedupe only for rhythm inference; the raw cluster is
 * preserved so the monthly paid total still includes every dollar that left.
 */
function distinctCadenceOccurrences(items) {
  const seen = new Map();
  for (const item of [...items].sort((a, b) => a.posted_date.localeCompare(b.posted_date))) {
    const key = `${item.posted_date}::${round(Math.abs(Number(item.amount))).toFixed(2)}`;
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}

function priceClusters(items) {
  const clusters = [];
  for (const item of items) {
    let cluster = clusters.find((c) => samePrice(c.anchor, item.amount));
    if (!cluster) {
      cluster = { anchor: item.amount, items: [] };
      clusters.push(cluster);
    }
    cluster.items.push(item);
  }
  return clusters;
}

function candidateFromCluster(cluster, minOccurrences) {
  const cadenceItems = distinctCadenceOccurrences(cluster.items);
  if (cadenceItems.length < minOccurrences) return null;
  const cadence = inferCadence(cadenceItems.map((t) => t.posted_date));
  if (cadence === 'irregular') return null;
  return {
    // Keep all matching charges for cash-history totals. Only cadenceItems are
    // deduped; bill-center.js intentionally sums same-day charges into one row.
    items: cluster.items,
    cadenceObservations: cadenceItems.length,
    cadence,
    lastSeen: cadenceItems.at(-1).posted_date,
  };
}

/** Pick the newest real rhythm, then the one with the most cadence evidence. */
function bestCandidate(clusters, minOccurrences) {
  return clusters
    .map((cluster) => candidateFromCluster(cluster, minOccurrences))
    .filter(Boolean)
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)
      || b.cadenceObservations - a.cadenceObservations)[0] ?? null;
}

function bestFixedFallback(items) {
  const candidates = items.filter((t) => FALLBACK_CATEGORIES.has(t.category));
  return bestCandidate(priceClusters(candidates), 3);
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

function missedPastGrace(nextExpected, asOf, graceDays) {
  if (!nextExpected || !asOf) return false;
  return String(asOf).slice(0, 10) > addDays(nextExpected, graceDays);
}

/**
 * @param {object[]} transactions
 * @param {object} [opts]
 * @param {string} [opts.asOf] ISO local calendar date. Supplying it lets the
 *   Bills screen stop projecting a stream that has clearly missed its cycle.
 * @param {number} [opts.missedGraceDays=21]
 * @returns recurring-stream objects compatible with bill-center.js.
 */
export function buildReliableSubscriptionStreams(transactions = [], opts = {}) {
  const streams = [];
  const graceDays = opts.missedGraceDays ?? DEFAULT_MISSED_GRACE_DAYS;

  for (const group of groupAliases(outflows(transactions))) {
    const strong = group.items.filter(strongEvidence);
    let chosen = bestCandidate(priceClusters(strong), 2);

    if (!chosen) chosen = bestFixedFallback(group.items);
    if (!chosen) continue;

    const sorted = [...chosen.items].sort((a, b) => a.posted_date.localeCompare(b.posted_date));
    const dates = sorted.map((t) => t.posted_date);
    const amounts = sorted.map((t) => round(Math.abs(Number(t.amount))));
    const last = sorted.at(-1);
    const nextExpected = projectNext(chosen.lastSeen, chosen.cadence);

    // A stale bank pattern is useful history, but it is not an obligation the
    // household should be told WILL debit. Keep stale/cancelled-looking streams
    // out of Bills; transaction history remains untouched.
    if (missedPastGrace(nextExpected, opts.asOf, graceDays)) continue;

    streams.push({
      account_id: group.account_id,
      payee: displayName(sorted),
      category: 'Subscriptions',
      kind: 'subscription',
      cadence: chosen.cadence,
      fixedPrice: fixedPrice(amounts),
      typical_amount: round(median(amounts)),
      last_amount: amounts.at(-1),
      amounts,
      dates,
      occurrences: sorted.length,
      cadence_observations: chosen.cadenceObservations,
      last_seen: chosen.lastSeen,
      next_expected: nextExpected,
      confidence: chosen.cadenceObservations >= 3 ? 'high' : 'low',
    });
  }

  return streams.sort((a, b) => b.typical_amount - a.typical_amount);
}
