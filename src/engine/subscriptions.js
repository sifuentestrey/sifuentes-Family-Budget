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
  // Compare against the most common value rather than the spread, so a stream
  // that stepped once still reads as fixed-price on each side of the step.
  const counts = new Map();
  for (const a of amounts) {
    const key = a.toFixed(2);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const modeCount = Math.max(...counts.values());
  // At least half the charges being identical means a set price.
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

  // Start at 2 so there are always at least two prior charges establishing the
  // old price. A change from a single observation is not a change from a price.
  for (let i = 2; i < amounts.length; i++) {
    const before = amounts[i - 1];
    const after = amounts[i];
    if (!before) continue;

    const change = (after - before) / before;
    if (Math.abs(change) < PRICE_INCREASE_THRESHOLD) continue;

    // Both sides must be stable, not just the new one.
    //
    // Checking only forward misreads a one-off spike: in [10, 10, 25, 10, 10]
    // the drop from 25 back to 10 "holds" for the rest of the series, so it
    // reports a 60% price decrease when the actual price never moved. The prior
    // level has to have been a real price too.
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

/**
 * Analyze subscriptions.
 *
 * @param {Array<object>} transactions
 * @param {object} [opts]
 * @param {number} [opts.forgottenDays=75] - no charge in this long looks dormant
 */
export function analyzeSubscriptions(transactions, opts = {}) {
  const streams = detectRecurringStreams(transactions, { direction: 'outflow' });

  const analyzed = streams.map((stream) => {
    const perYear = PER_YEAR[stream.cadence] ?? 0;
    const kind = classifyStream(stream.category);
    const fixedPrice = isFixedPrice(stream.amounts);

    // Price-change detection only on set-price streams. On a grocery or fuel
    // merchant every normal fluctuation would read as a price rise.
    const priceChange = fixedPrice ? detectPriceChange(stream.amounts) : null;

    // Annualize on the CURRENT price, not the median. After an increase the
    // median lags behind what the household will actually be charged.
    const annualCost = round(stream.last_amount * perYear);

    return {
      ...stream,
      kind,
      fixedPrice,
      // Shown as the primary figure. "$15.99/mo" does not register as a
      // decision; "$191.88/yr" does.
      annualCost,
      monthlyEquivalent: round(annualCost / 12),
      priceChange,
      // Extra yearly cost the household absorbed without deciding to.
      annualImpactOfIncrease: priceChange
        ? round(priceChange.changeAmount * perYear)
        : 0,
    };
  });

  const subscriptions = analyzed.filter((s) => s.kind === 'subscription');
  const bills = analyzed.filter((s) => s.kind === 'bill');

  return {
    // The cancellable list — what "subscriptions" should actually mean.
    subscriptions,
    // Recurring obligations. Worth forecasting; not candidates for cancelling.
    bills,
    // Places the household simply shops often. Neither, and excluded from both
    // so the lists stay actionable.
    frequentMerchants: analyzed.filter((s) => s.kind === 'merchant'),

    totalAnnual: round(subscriptions.reduce((s, x) => s + x.annualCost, 0)),
    totalMonthly: round(subscriptions.reduce((s, x) => s + x.monthlyEquivalent, 0)),
    billsAnnual: round(bills.reduce((s, x) => s + x.annualCost, 0)),

    // Price changes matter on bills too — an insurance renewal is exactly the
    // kind of quiet increase worth catching.
    priceIncreases: [...subscriptions, ...bills].filter(
      (s) => s.priceChange?.direction === 'increase',
    ),
    duplicates: findDuplicateServices(subscriptions),
    possiblyForgotten: findForgotten(subscriptions, opts.forgottenDays ?? 75),
    lowConfidence: subscriptions.filter((s) => s.confidence === 'low'),
  };
}

/**
 * Streams sharing a category that plausibly do the same job.
 *
 * Phrased as a question in the UI, never an assertion — two streaming services
 * may both be wanted, and a tool that confidently tells someone to cancel
 * something they use loses their trust for everything else it says.
 */
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

/**
 * Streams that are still charging but overdue relative to their own cadence.
 *
 * A heuristic about the household's life, not their data, so it is surfaced as
 * a prompt rather than a conclusion.
 */
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

/**
 * Known cancellation routes.
 *
 * This is the honest version of Rocket Money's concierge: it saves the lookup,
 * not the phone call. Nobody cancels on the household's behalf, and the UI
 * says so rather than implying otherwise.
 */
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

/**
 * Draft a cancellation message the household can send themselves.
 */
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

/**
 * Bills worth trying to negotiate, with a script.
 *
 * Rocket Money charges 35-60% of the first year's savings for a person to make
 * this call. This is the same call, made by the household, keeping all of it.
 */
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
