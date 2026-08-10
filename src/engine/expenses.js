/**
 * The expense picture.
 *
 * Answers "what do we actually need every month" before any savings question
 * gets asked. Everything downstream — the buffer target, the emergency fund,
 * how much a paycheck can spare — is derived from these numbers, so getting the
 * classification right matters more than it looks.
 *
 * Four buckets, because "expenses" as a single number hides the only
 * distinction that matters in a crisis: what you must pay versus what you
 * choose to pay.
 *
 *   committed  - same every month, non-negotiable. Rent, childcare, insurance.
 *   necessary  - fluctuates but unavoidable. Groceries, gas, utilities.
 *   discretionary - dining, shopping, subscriptions, entertainment.
 *   irregular  - annual/quarterly. Insurance premiums, registration, holidays.
 *
 * The committed + necessary total is what an emergency fund should cover.
 * Sizing one against *total* spending — including restaurants and shopping that
 * would obviously stop — inflates the target by thousands and makes people
 * conclude it is unreachable.
 */

import { SEED_CATEGORIES } from './seed-rules.js';

/**
 * Categories that are unavoidable even though the amount moves.
 * Distinguished from discretionary variable spending, which is the part a
 * household can actually cut under pressure.
 */
const NECESSARY_VARIABLE = new Set([
  'Groceries', 'Gas', 'Utilities', 'Internet/Phone', 'Pharmacy', 'Medical',
  'Parking/Transit', 'Kids Supplies',
]);

/** Bucket lookup built from the seed taxonomy, which already carries a kind. */
function defaultBuckets() {
  const map = new Map();
  for (const [, name, kind] of SEED_CATEGORIES) {
    if (kind === 'income' || kind === 'transfer') continue;
    if (kind === 'fixed') map.set(name, 'committed');
    else if (kind === 'sinking') map.set(name, 'irregular');
    else map.set(name, NECESSARY_VARIABLE.has(name) ? 'necessary' : 'discretionary');
  }
  return map;
}

/**
 * Fraction of analyzed months a category must appear in to count as recurring.
 * Below this it is treated as irregular and amortized instead of medianed.
 */
const REGULAR_PRESENCE = 0.5;

/** History below this makes presence-based irregular detection meaningless. */
const MIN_MONTHS_FOR_PATTERN = 4;

/**
 * Classify a category into a bucket.
 * User overrides win, exactly like learned categorization rules — the household
 * knows things the taxonomy does not.
 */
export function bucketFor(category, overrides = new Map()) {
  if (!category) return 'discretionary';
  if (overrides.has(category)) return overrides.get(category);
  return defaultBuckets().get(category) ?? 'discretionary';
}

/**
 * Reclassify a category as irregular based on its actual pattern.
 *
 * The declared taxonomy cannot know how a given household pays. "Car Insurance"
 * is labelled fixed because most people pay monthly — but paid as a single
 * annual premium it is the archetypal sinking-fund expense, and treating a
 * $1,428 yearly charge as a fixed monthly cost is wrong in both directions at
 * once: it overstates every month it doesn't occur and understates the one it
 * does.
 *
 * So the pattern wins over the label: anything landing in half the months or
 * fewer is amortized rather than medianed. This also fixes a subtler bug — a
 * median across months where a category never occurred collapses to zero, which
 * silently erases real spending from the picture.
 */
function isIrregularPattern(monthsPresent, monthsAnalyzed) {
  if (monthsAnalyzed < MIN_MONTHS_FOR_PATTERN) return false;
  return monthsPresent / monthsAnalyzed <= REGULAR_PRESENCE;
}

/**
 * Drop months with obviously truncated history.
 *
 * The oldest month in a newly-connected account is usually partial — history
 * starts mid-month, or the connection was made mid-month. A partial month looks
 * identical to a frugal one, and including it corrupts everything downstream:
 * groceries appearing in 4 of 6 months get reclassified as an irregular expense,
 * and the monthly medians they feed drop below what the household actually
 * spends.
 *
 * Heuristic: a month with fewer than 40% of the median month's transaction
 * count is truncated, not thrifty. Deliberately conservative — dropping a
 * genuinely quiet month costs a little precision, while keeping a truncated one
 * understates the budget, and understating is the more damaging error.
 */
function dropPartialMonths(spending, months) {
  if (months.length < 3) return months;

  const counts = new Map();
  for (const txn of spending) {
    const month = monthKey(txn.posted_date);
    counts.set(month, (counts.get(month) || 0) + 1);
  }

  const values = months.map((m) => counts.get(m) || 0);
  const typical = median(values);
  if (!typical) return months;

  const kept = months.filter((m) => (counts.get(m) || 0) >= typical * 0.4);
  // Never discard so much that the analysis becomes meaningless.
  return kept.length >= 2 ? kept : months;
}

function monthKey(date) {
  return date.slice(0, 7);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Spending transactions only — the same exclusions used everywhere else.
 * Transfers already counted at the swipe; income is not negative spending;
 * split parents are represented by their children.
 */
function spendingOnly(transactions) {
  const parents = new Set(transactions.map((t) => t.parent_transaction_id).filter(Boolean));
  return transactions.filter(
    (t) =>
      !t.is_transfer &&
      !t.is_income &&
      !t.pending &&
      t.amount > 0 &&
      !parents.has(t.plaid_transaction_id ?? t.id),
  );
}

/**
 * Build the expense picture from transaction history.
 *
 * @param {Array<object>} transactions
 * @param {object} [opts]
 * @param {Map<string,string>} [opts.overrides] - category -> bucket
 * @param {number} [opts.months=6] - trailing window
 * @returns {object} the picture
 */
export function buildExpensePicture(transactions, opts = {}) {
  const overrides = opts.overrides ?? new Map();
  const spending = spendingOnly(transactions);
  if (!spending.length) return emptyPicture();

  const months = [...new Set(spending.map((t) => monthKey(t.posted_date)))].sort();
  const candidate = opts.months ? months.slice(-opts.months) : months;
  const window = dropPartialMonths(spending, candidate);

  // First pass: gather each category's own history.
  const byCategory = new Map();
  for (const txn of spending) {
    const month = monthKey(txn.posted_date);
    if (!window.includes(month)) continue;

    const category = txn.category || 'Uncategorized';
    if (!byCategory.has(category)) {
      byCategory.set(category, {
        category,
        declaredBucket: bucketFor(txn.category, overrides),
        total: 0,
        byMonth: new Map(),
        count: 0,
      });
    }
    const entry = byCategory.get(category);
    entry.total += txn.amount;
    entry.byMonth.set(month, (entry.byMonth.get(month) || 0) + txn.amount);
    entry.count++;
  }

  // Second pass: let the observed pattern override the declared bucket, then
  // aggregate. Regular categories use a median over the months they actually
  // occurred in — never across empty months, which would collapse to zero and
  // erase real spending. Irregular ones are amortized instead.
  const monthlyByBucket = { committed: 0, necessary: 0, discretionary: 0, irregular: 0 };
  let irregularAnnual = 0;
  const categories = [];

  for (const entry of byCategory.values()) {
    const monthsPresent = entry.byMonth.size;
    const overridden = overrides.has(entry.category);
    const irregular =
      !overridden && isIrregularPattern(monthsPresent, window.length)
        ? true
        : entry.declaredBucket === 'irregular';

    const bucket = irregular ? 'irregular' : entry.declaredBucket;

    let monthlyAmount;
    if (bucket === 'irregular') {
      // Spread across the year, so the premium is funded before it lands.
      const annualized = entry.total * (12 / window.length);
      irregularAnnual += annualized;
      monthlyAmount = annualized / 12;
    } else {
      monthlyAmount = median([...entry.byMonth.values()]);
    }

    monthlyByBucket[bucket] += monthlyAmount;
    categories.push({
      category: entry.category,
      bucket,
      // True when the pattern overrode the taxonomy — worth surfacing, since
      // it is the kind of reclassification a user may want to correct.
      reclassified: irregular && entry.declaredBucket !== 'irregular',
      monthlyAverage: round(monthlyAmount),
      total: round(entry.total),
      monthsPresent,
      transactionCount: entry.count,
    });
  }

  categories.sort((a, b) => b.monthlyAverage - a.monthlyAverage);

  const committed = monthlyByBucket.committed;
  const necessary = monthlyByBucket.necessary;
  const discretionary = monthlyByBucket.discretionary;
  const irregularMonthly = monthlyByBucket.irregular;

  const baseline = committed + necessary;
  const trueMonthlyCost = baseline + irregularMonthly + discretionary;
  const irregularTotal = irregularAnnual;

  return {
    monthsAnalyzed: window.length,
    monthly: {
      committed: round(committed),
      necessary: round(necessary),
      discretionary: round(discretionary),
      irregular: round(irregularMonthly),
    },
    // What must be covered every month, no matter what.
    baselineMonthlyNeed: round(baseline),
    // Baseline plus irregular bills amortized plus normal discretionary. The
    // honest "what this household costs to run" figure.
    trueMonthlyCost: round(trueMonthlyCost),
    // What an emergency fund should be sized against — the survival number,
    // materially smaller than total spending.
    survivalMonthlyCost: round(baseline + irregularMonthly),
    discretionaryShare: trueMonthlyCost
      ? Number(((discretionary / trueMonthlyCost) * 100).toFixed(1))
      : 0,
    irregularAnnualTotal: round(irregularTotal),
    categories,
    largestMovable: categories.filter((c) => c.bucket === 'discretionary').slice(0, 5),
  };
}

/**
 * Does reliable income cover what the household actually costs?
 *
 * The most important number in the app. If it is negative, no savings plan is
 * meaningful and the honest answer is to say so — emitting an encouraging
 * savings target on top of a structural deficit would be actively harmful.
 *
 * @param {object} picture - from buildExpensePicture
 * @param {number} reliableMonthlyIncome - conservative floor, not average
 */
export function floorCoverage(picture, reliableMonthlyIncome) {
  const survival = picture.survivalMonthlyCost;
  const full = picture.trueMonthlyCost;

  const survivalGap = reliableMonthlyIncome - survival;
  const fullGap = reliableMonthlyIncome - full;

  let status;
  if (survivalGap < 0) status = 'deficit';           // floor income cannot cover necessities
  else if (fullGap < 0) status = 'tight';            // necessities covered, discretionary is not
  else status = 'covered';

  return {
    status,
    reliableMonthlyIncome: round(reliableMonthlyIncome),
    survivalMonthlyCost: survival,
    trueMonthlyCost: full,
    // Headroom above necessities on a bad month — the real capacity to save.
    survivalSurplus: round(survivalGap),
    fullSurplus: round(fullGap),
    message: {
      deficit:
        'On a slow stretch, income does not cover necessities. Savings targets are ' +
        'not meaningful until this gap closes — the priority is raising the floor or ' +
        'cutting committed costs.',
      tight:
        'Necessities are covered on a bad month, but not current discretionary spending. ' +
        'Slow stretches will draw down savings unless discretionary flexes with income.',
      covered:
        'Even on a slow stretch, income covers the full cost of running the household. ' +
        'Everything above the floor is genuinely available to put away.',
    }[status],
  };
}

function round(n) {
  return Number(n.toFixed(2));
}

function emptyPicture() {
  return {
    monthsAnalyzed: 0,
    monthly: { committed: 0, necessary: 0, discretionary: 0, irregular: 0 },
    baselineMonthlyNeed: 0,
    trueMonthlyCost: 0,
    survivalMonthlyCost: 0,
    discretionaryShare: 0,
    irregularAnnualTotal: 0,
    categories: [],
    largestMovable: [],
  };
}
