/**
 * Pure recurring-obligation logic. No network, database, or provider credentials.
 *
 * The important distinction is between a recurring transaction and a household
 * obligation. Transfers, credit-card payments, and income are evidence, not bills.
 */

const DAY = 86_400_000;

export const CLASSIFICATIONS = Object.freeze([
  'bill',
  'subscription',
  'debt_payment',
  'transfer',
  'income',
  'discretionary_recurring',
  'unknown',
]);

export function normalizePayee(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function classifyTransaction(tx) {
  const text = normalizePayee(`${tx.merchant ?? ''} ${tx.description ?? ''}`);
  const amount = Math.abs(Number(tx.amount) || 0);

  if (tx.isTransfer === true || /\b(transfer|zelle|venmo|cash app)\b/.test(text)) return 'transfer';
  if (tx.isIncome === true || Number(tx.amount) < 0 && /\b(payroll|salary|paycheck|direct deposit|wage)\b/.test(text)) return 'income';
  if (tx.creditCardPayment === true || /\b(credit card|card payment|autopay payment)\b/.test(text)) return 'debt_payment';
  if (amount === 0) return 'unknown';
  return 'unknown';
}

/**
 * Detect recurring streams while keeping transfer/income/card-payment streams out
 * of household spending. Transactions are expected to use positive amounts for
 * money leaving the account and negative amounts for deposits.
 */
export function discoverObligations(transactions, { minimumOccurrences = 3 } = {}) {
  const groups = new Map();

  for (const tx of transactions) {
    if (!tx?.date || !tx?.accountId) continue;
    const payee = normalizePayee(tx.merchant ?? tx.description ?? '');
    if (!payee) continue;

    const inferred = classifyTransaction(tx);
    if (inferred === 'transfer' || inferred === 'income') continue;

    const key = `${tx.accountId}:${payee}`;
    const list = groups.get(key) ?? [];
    list.push({ ...tx, payee, inferred });
    groups.set(key, list);
  }

  const results = [];
  for (const group of groups.values()) {
    if (group.length < minimumOccurrences) continue;

    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
    const intervals = sorted.slice(1).map((tx, i) => daysBetween(sorted[i].date, tx.date));
    const cadence = median(intervals);
    const frequency = cadence <= 10 ? 'weekly'
      : cadence <= 18 ? 'biweekly'
      : cadence <= 45 ? 'monthly'
      : cadence <= 120 ? 'quarterly'
      : cadence <= 400 ? 'annual'
      : null;
    if (!frequency) continue;

    const amounts = sorted.map(tx => Math.abs(Number(tx.amount) || 0)).filter(Number.isFinite);
    const averageAmount = amounts.reduce((sum, n) => sum + n, 0) / amounts.length;
    const amountSpread = averageAmount ? (Math.max(...amounts) - Math.min(...amounts)) / averageAmount : 0;

    // Regular cadence matters more than identical amounts for variable utilities.
    const cadenceConfidence = Math.min(0.65, 0.35 + Math.min(intervals.length, 6) * 0.05);
    const amountConfidence = Math.max(0, 0.25 - Math.min(amountSpread, 1) * 0.20);
    const confidence = Math.min(0.95, cadenceConfidence + amountConfidence);

    const last = sorted.at(-1);
    const next = new Date(`${last.date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + Math.round(cadence));

    results.push({
      merchant: last.merchant ?? last.description ?? last.payee,
      normalizedMerchant: last.payee,
      frequency,
      averageAmount: Number(averageAmount.toFixed(2)),
      amountRange: { min: Math.min(...amounts), max: Math.max(...amounts) },
      lastSeen: last.date,
      nextExpectedDate: next.toISOString().slice(0, 10),
      confidence: Number(confidence.toFixed(3)),
      accountId: last.accountId,
      transactionIds: sorted.map(tx => tx.id).filter(Boolean),
      classification: last.inferred === 'debt_payment' ? 'debt_payment' : 'unknown',
      needsReview: true,
    });
  }

  return results.sort((a, b) => b.confidence - a.confidence || a.nextExpectedDate.localeCompare(b.nextExpectedDate));
}

/**
 * Turn a confirmed discovery into a stable household obligation. Confirmation is
 * explicit so the app never silently converts an arbitrary recurring merchant into
 * a bill.
 */
export function confirmObligation(candidate, { classification, name, category } = {}) {
  if (!candidate || !CLASSIFICATIONS.includes(classification)) {
    throw new Error('A valid classification is required to confirm an obligation');
  }
  return {
    ...candidate,
    name: name ?? candidate.merchant,
    category: category ?? classification,
    classification,
    needsReview: false,
    confirmedAt: new Date().toISOString(),
  };
}

export function projectNextOccurrence(obligation, fromDate = new Date()) {
  const cadenceDays = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 91, annual: 365 }[obligation.frequency];
  if (!cadenceDays) return null;
  const next = new Date(fromDate);
  next.setUTCDate(next.getUTCDate() + cadenceDays);
  return next.toISOString().slice(0, 10);
}
