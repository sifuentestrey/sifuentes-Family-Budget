const CATEGORY_ALIASES = [
  ['Dining Out', ['dining out', 'restaurant', 'restaurants', 'dinner', 'takeout', 'fast food']],
  ['Groceries', ['grocery budget', 'groceries', 'grocery', 'food budget']],
  ['Entertainment', ['movie theater', 'movie theatre', 'entertainment', 'movies']],
  ['Gas', ['gas budget', 'fuel', 'gas']],
  ['Utilities', ['utilities', 'utility']],
  ['Subscriptions', ['subscriptions', 'subscription']],
  ['Medical', ['medical', 'pharmacy', 'health']],
];

const textKey = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[’']/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const round = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function titleCase(value) {
  return String(value ?? '').trim().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function categoryFromText(text) {
  const normalized = textKey(text);
  for (const [category, aliases] of CATEGORY_ALIASES) {
    if (aliases.some((alias) => normalized.includes(textKey(alias)))) return category;
  }
  return null;
}

function cleanMerchant(value) {
  return titleCase(String(value ?? '')
    .replace(/^(please\s+)?(add|make|create|set)\s+(a\s+)?rule\s+(that|for)?\s*/i, '')
    .replace(/^(please\s+)?(put|categorize|classify|change)\s+/i, '')
    .replace(/\s+(as|under|in|to|toward|towards|counts?|adds?|goes?)\b.*$/i, '')
    .replace(/[.,!?]+$/g, '')
    .trim());
}

export function parseFinanceAdvisorIntent(input) {
  const text = String(input ?? '').trim();
  const normalized = textKey(text);
  if (!normalized) return { type: 'empty' };

  if (/\b(dinner|eat tonight|tonight to eat|restaurant tonight|takeout tonight)\b/i.test(text)) {
    return { type: 'dinner' };
  }

  const notSubscription = /\b(isn['’]?t|is not|isnt|not)\s+(a\s+)?subscription\b/i.test(text);
  if (notSubscription) {
    const match = text.match(/^(.+?)\s+(?:isn['’]?t|is not|isnt|not)\s+(?:a\s+)?subscription\b/i);
    const merchant = cleanMerchant(match?.[1]);
    if (merchant) {
      return {
        type: 'merchant_rule',
        merchant,
        category: categoryFromText(text) || 'Entertainment',
        suppressRecurring: true,
      };
    }
  }

  const ruleMatch = text.match(/(?:rule\s+(?:that|for)\s+)?(.+?)\s+(?:adds?|counts?|goes?|belongs?)\s+(?:as|to|toward|towards|in|under)?\s*(.+)$/i)
    || text.match(/(?:categorize|classify|put|change)\s+(.+?)\s+(?:as|to|under|in)\s+(.+)$/i);
  if (ruleMatch) {
    const merchant = cleanMerchant(ruleMatch[1]);
    const category = categoryFromText(ruleMatch[2]) || categoryFromText(text);
    if (merchant && category) {
      return { type: 'merchant_rule', merchant, category, suppressRecurring: false };
    }
  }

  return { type: 'question', question: text };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, point) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * point;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function recentRestaurantStats(transactions, asOf) {
  const cutoff = new Date(`${asOf}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 180);
  const start = cutoff.toISOString().slice(0, 10);
  const groups = new Map();

  for (const transaction of transactions ?? []) {
    const amount = Number(transaction.amount);
    const date = transaction.posted_date || transaction.date;
    if (!date || date < start || date > asOf || amount <= 0
      || transaction.pending || transaction.is_transfer || transaction.is_income
      || transaction.parent_transaction_id || transaction.category !== 'Dining Out') continue;
    const key = textKey(transaction.payee);
    if (!key) continue;
    const group = groups.get(key) ?? { merchant: transaction.payee, visits: [], lastVisit: date };
    group.visits.push(amount);
    if (date > group.lastVisit) {
      group.lastVisit = date;
      group.merchant = transaction.payee;
    }
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter((group) => group.visits.length >= 2)
    .map((group) => ({
      merchant: group.merchant,
      visits: group.visits.length,
      typical: round(median(group.visits)),
      low: round(quantile(group.visits, 0.25)),
      high: round(quantile(group.visits, 0.75)),
      lastVisit: group.lastVisit,
    }))
    .sort((a, b) => b.visits - a.visits || b.lastVisit.localeCompare(a.lastVisit));
}

export function buildDinnerGuidance({ asOf, transactions = [], plan } = {}) {
  const allowance = plan?.allowances?.find((row) => row.category === 'Dining Out');
  const checking = Number(plan?.facts?.checking?.available ?? 0);
  const billsDue = Number(plan?.facts?.dueBeforeNextPayday?.total ?? 0);
  const checkingAfterBills = round(checking - billsDue);
  const payday = plan?.forecasts?.nextPaycheck?.date ?? null;
  const restaurantStats = recentRestaurantStats(transactions, asOf);

  if (!allowance) {
    return {
      status: 'needs_target',
      amount: null,
      label: 'Set a Dining Out target first',
      explanation: 'There is no agreed Dining Out budget, so the app will not turn checking into a made-up dinner allowance.',
      payday,
      confidence: 'high',
      basedOn: ['household budget targets'],
      restaurantStats,
    };
  }

  const categoryLeft = Math.max(0, Number(allowance.left ?? 0));
  const amount = round(Math.max(0, Math.min(categoryLeft, checkingAfterBills)));
  const allBillsVerified = (plan?.facts?.dueBeforeNextPayday?.bills ?? [])
    .every((bill) => bill.amountSource === 'verified amount');
  const balanceAvailable = plan?.diagnostics?.checkingBalanceIsAvailable !== false;
  const confidence = allBillsVerified && balanceAvailable ? 'high' : 'medium';
  const recommendation = restaurantStats.find((row) => row.typical <= amount) ?? null;

  if (checkingAfterBills < 0) {
    return {
      status: 'gap', amount: 0, label: 'No dinner amount in the current plan',
      explanation: `$${Math.abs(checkingAfterBills).toFixed(2)} is needed to cover bills due before payday after using current checking.`,
      payday, confidence, categoryLeft: round(categoryLeft), checkingAfterBills,
      basedOn: ['connected checking', 'bills due before payday', 'Dining Out target'],
      restaurantStats, recommendation: null,
    };
  }

  return {
    status: amount > 0 ? 'available' : 'none',
    amount,
    label: 'Dinner amount in this paycheck plan',
    explanation: payday
      ? `$${categoryLeft.toFixed(2)} remains in Dining Out through ${payday}; current checking after bills due before then is $${checkingAfterBills.toFixed(2)}.`
      : `$${categoryLeft.toFixed(2)} remains in Dining Out; no reliable next payday is available.`,
    payday, confidence, categoryLeft: round(categoryLeft), checkingAfterBills,
    basedOn: ['connected checking', 'bills due before payday', 'Dining Out target'],
    restaurantStats, recommendation,
  };
}

export function merchantMatchKey(value) {
  return textKey(value).replace(/\s+/g, '');
}
