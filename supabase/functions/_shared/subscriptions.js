// GENERATED FILE — do not edit.
// Source of truth: src/engine/subscriptions.js
// Regenerate with: npm run sync:shared
/**
 * Subscription analysis.
 *
 * Built on the generic recurring detector, so subscriptions and paychecks are
 * recognized by the same code.
 *
 * The analysis beyond detection is where the value is. A list of recurring
 * charges is mildly interesting; knowing that one quietly went up 12%, that
 * two of them do the same job, and that the annual total is four figures is
 * what actually changes behavior.
 */

import { detectRecurringStreams } from './recurring.js';

/** Annualization multipliers by cadence. */
const PER_YEAR = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  quarterly: 4,
  irregular: 0,
};

/** Minimum relative jump treated as a price increase rather than noise. */
const PRICE_INCREASE_THRESHOLD = 0.03;

/** Categories where paying twice usually means paying twice for the same thing. */
const OVERLAPPING_CATEGORIES = new Set(['Subscriptions', 'Entertainment', 'Fitness']);

/**
 * Not every recurring charge is a subscription.
 *
 * Rent recurs monthly. So does childcare, and the electric bill, and — at a
 * regular enough rhythm to be detected — the weekly grocery run. Lumping them
 * together produces a "subscriptions" list topped by rent, which is useless
 * for the one thing the list exists for: deciding what to cancel.
 *
 * Three kinds, treated differently:
 *
 *   subscription - a service that could be cancelled tomorrow. The list.
 *   bill         - a recurring obligation. Worth forecasting, not cancelling.
 *   merchant     - somewhere the household simply shops often. Neither.
 */
const SUBSCRIPTION_CATEGORIES = new Set([
  'Subscriptions', 'Entertainment', 'Fitness', 'Hobbies',
]);

const BILL_CATEGORIES = new Set([
  'Rent/Mortgage', 'Utilities', 'Internet/Phone', 'Insurance', 'Car Insurance',
  'Health Insurance', 'Childcare', 'Car Payment', 'Taxes',
]);

export function classifyStream(category) {
  if (!category) return 'merchant';
  if (SUBSCRIPTION_CATEGORIES.has(category)) return 'subscription';
  if (BILL_CATEGORIES.has(category)) return 'bill';
  return 'merchant';
}

/**
 * Variance above which amounts are considered naturally fluctuating.
 *
 * A real subscription charges the same figure every period, so any change is
 * a genuine price change. A grocery run varies by 10-20% every week, and
 * reporting that as "Safeway raised prices 11%" would bury the one alert that
 * matters — the streaming service that quietly went up — under noise.
 */
const FIXED_PRICE_VARIANCE = 0.02;

function isFixedPrice(amounts) {
  if (amounts.length < 2) return false;
  const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  if (!avg) return false;
  const counts = new Map();
  for (const a of amounts) {
    const key = a.toFixed(2);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const modeCount = Math.max(...counts.values());
  return modeCount / amounts.length >= 0.4;
}

function round(n) {
  return Number(n.toFixed(2));
}

/**
 * Detect a sustained price change within a stream.
 *
 * Deliberately requires the new price to *hold*, not merely to appear once —
 * a single larger charge is usually a prorated month or an extra device, not a
 * price rise. Treating those as increases would generate alerts constantly and
 * the real increases would be lost among them.
 */
export function detectPriceChange(amounts) {
  if (amounts.length < 3) return null;

  for (let i = 2; i < amounts.length; i++) {
    const before = amounts[i - 1];
    const after = amounts[i];
    if (!before) continue;

    const change = (after - before) / before;
    if (Math.abs(change) < PRICE_INCREASE_THRESHOLD) continue;

    const priorHeld = amounts
      .slice(0, i)
      .every((a) => Math.abs((a - before) / before) < PRICE_INCREASE_THRESHOLD);
    if (!priorHeld) continue;

    const subsequent = amounts.slice(i);
    const held = subsequent.every((a) => Math.abs((a - after) / after) < PRICE_INCREASE_THRESHOLD);
    if (!held) continue;

    return {
      from: round(before),
      to: round(after),
      changeAmount: round(after - before),
      changePercent: Number((change * 100).toFixed(1)),
      direction: change > 0 ? 'increase' : 'decrease',
      atIndex: i,
    };
  }
  return null;
}

/** Analyze subscriptions and recurring obligations. */
export function analyzeSubscriptions(transactions, opts = {}) {
  const streams = detectRecurringStreams(transactions, { direction: 'outflow' });

  const analyzed = streams.map((stream) => {
    const perYear = PER_YEAR[stream.cadence] ?? 0;
    const kind = classifyStream(stream.category);
    const fixedPrice = isFixedPrice(stream.amounts);
    const priceChange = fixedPrice ? detectPriceChange(stream.amounts) : null;
    const annualCost = round(stream.last_amount * perYear);

    return {
      ...stream,
      kind,
      fixedPrice,
      annualCost,
      monthlyEquivalent: round(annualCost / 12),
      priceChange,
      annualImpactOfIncrease: priceChange
        ? round(priceChange.changeAmount * perYear)
        : 0,
    };
  });

  const subscriptions = analyzed.filter((s) => s.kind === 'subscription');
  const bills = analyzed.filter((s) => s.kind === 'bill');

  return {
    subscriptions,
    bills,
    frequentMerchants: analyzed.filter((s) => s.kind === 'merchant'),
    totalAnnual: round(subscriptions.reduce((s, x) => s + x.annualCost, 0)),
    totalMonthly: round(subscriptions.reduce((s, x) => s + x.monthlyEquivalent, 0)),
    billsAnnual: round(bills.reduce((s, x) => s + x.annualCost, 0)),
    priceIncreases: [...subscriptions, ...bills].filter(
      (s) => s.priceChange?.direction === 'increase',
    ),
    duplicates: findDuplicateServices(subscriptions),
    possiblyForgotten: findForgotten(subscriptions, opts.forgottenDays ?? 75),
    lowConfidence: subscriptions.filter((s) => s.confidence === 'low'),
  };
}

function findDuplicateServices(subscriptions) {
  const byCategory = new Map();
  for (const sub of subscriptions) {
    if (!sub.category || !OVERLAPPING_CATEGORIES.has(sub.category)) continue;
    if (!byCategory.has(sub.category)) byCategory.set(sub.category, []);
    byCategory.get(sub.category).push(sub);
  }

  return [...byCategory.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([category, group]) => ({
      category,
      services: group.map((s) => ({ payee: s.payee, annualCost: s.annualCost })),
      combinedAnnual: round(group.reduce((s, x) => s + x.annualCost, 0)),
      question: `You're paying for ${group.length} services in ${category}. Still using all of them?`,
    }));
}

function findForgotten(subscriptions, thresholdDays) {
  const now = Date.now();
  return subscriptions
    .filter((sub) => {
      const sinceLast = (now - new Date(sub.last_seen).getTime()) / 86400000;
      return sinceLast > thresholdDays && sub.cadence === 'monthly';
    })
    .map((sub) => ({
      payee: sub.payee,
      annualCost: sub.annualCost,
      lastCharge: sub.last_seen,
      question: `${sub.payee} has been charging ${sub.annualCost ? `$${sub.annualCost}/yr` : ''} — still using it?`,
    }));
}

const CANCEL_ROUTES = {
  netflix: { url: 'https://www.netflix.com/cancelplan', method: 'online' },
  spotify: { url: 'https://www.spotify.com/account/subscription/', method: 'online' },
  hulu: { url: 'https://secure.hulu.com/account', method: 'online' },
  'apple music': { url: 'https://support.apple.com/en-us/HT202039', method: 'online' },
  'planet fitness': { phone: 'visit your home club or send certified mail', method: 'in_person' },
  'new york times': { phone: '1-800-591-9233', method: 'phone' },
  audible: { url: 'https://www.audible.com/account', method: 'online' },
  adobe: { url: 'https://account.adobe.com/plans', method: 'online' },
};

export function cancellationRoute(payee) {
  const key = payee.toLowerCase();
  for (const [name, route] of Object.entries(CANCEL_ROUTES)) {
    if (key.includes(name)) return route;
  }
  return null;
}

export function draftCancellation(subscription) {
  return {
    subject: `Cancel my subscription — ${subscription.payee}`,
    body:
      `Hello,\n\n` +
      `I'd like to cancel my subscription, effective at the end of the current ` +
      `billing period. My most recent charge was $${subscription.last_amount} on ` +
      `${subscription.last_seen}.\n\n` +
      `Please confirm the cancellation in writing and let me know the date my ` +
      `access ends. I'm not looking for a retention offer.\n\n` +
      `Thank you.`,
    route: cancellationRoute(subscription.payee),
    note: 'You send this. Nobody cancels on your behalf here.',
  };
}

const NEGOTIABLE = ['Internet/Phone', 'Insurance', 'Car Insurance', 'Subscriptions'];

export function negotiationCandidates(subscriptions) {
  return subscriptions
    .filter((s) => NEGOTIABLE.includes(s.category) && s.annualCost > 200)
    .map((sub) => ({
      payee: sub.payee,
      monthly: sub.last_amount,
      annual: sub.annualCost,
      monthsAsCustomer: sub.occurrences,
      priceIncreased: Boolean(sub.priceChange?.direction === 'increase'),
      script: buildNegotiationScript(sub),
    }));
}

function buildNegotiationScript(sub) {
  const lines = [
    `Ask for the retention or cancellation department — front-line staff usually can't approve discounts.`,
    `"I've been a customer for about ${sub.occurrences} billing periods and I'm paying $${sub.last_amount} a month."`,
  ];

  if (sub.priceChange?.direction === 'increase') {
    lines.push(
      `"My rate went from $${sub.priceChange.from} to $${sub.priceChange.to} — that's ` +
      `$${sub.annualImpactOfIncrease} more a year. What can you do to bring it back down?"`,
    );
  }

  lines.push(
    `"I'm comparing options and I'd rather stay if the price works."`,
    `Then stop talking. Silence does the work; the first person to fill it usually concedes.`,
    `If they refuse, ask to cancel. That often reroutes you to someone who can approve more.`,
    `Get any agreed change in writing, and note the date it takes effect.`,
  );

  return lines;
}
