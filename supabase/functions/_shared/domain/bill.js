// GENERATED FILE — do not edit.
// Source of truth: src/domain/bill.js
// Regenerate with: npm run sync:shared
/**
 * Bill domain model.
 *
 * A Bill is the normalized result of ingestion, whatever the source. Email,
 * PDF, provider API, portal scrape, and manual entry all converge here so
 * everything downstream — budget, safe-to-spend, payment tracking — reads one
 * shape and never has to know where a bill came from.
 *
 * `confidence` is load-bearing. A bill parsed out of an email body is a guess,
 * and the system must be able to say how good a guess. Anything below
 * REVIEW_THRESHOLD is surfaced for confirmation rather than silently budgeted
 * against — a wrong amount that looks authoritative is worse than an obvious
 * gap.
 */

/** @typedef {'email'|'pdf'|'provider_api'|'provider_portal'|'manual'|'bank'} BillSourceType */
/** @typedef {'detected'|'confirmed'|'scheduled'|'paid'|'overdue'|'disputed'|'ignored'} BillStatus */

/**
 * `bank` is a bill the household started tracking from a recurring charge
 * already visible in their own transactions — evidence they have paid this
 * before, not a parse of a document. Kept distinct from `manual` so the UI
 * can say where an amount came from.
 */
export const BILL_SOURCE_TYPES = /** @type {BillSourceType[]} */ ([
  'email', 'pdf', 'provider_api', 'provider_portal', 'manual', 'bank',
]);

export const BILL_STATUSES = /** @type {BillStatus[]} */ ([
  'detected', 'confirmed', 'scheduled', 'paid', 'overdue', 'disputed', 'ignored',
]);

/**
 * Categories bills map into. Deliberately aligned with the budget's existing
 * category names (see src/engine/seed-rules.js) so a bill and the bank
 * transaction that pays it land in the same bucket.
 */
export const BILL_CATEGORIES = [
  'Utilities', 'Internet/Phone', 'Rent/Mortgage', 'Insurance', 'Car Insurance',
  'Health Insurance', 'Car Payment', 'Childcare', 'Subscriptions', 'Medical',
  'Taxes', 'Other',
];

/** Below this, a parsed bill is shown for confirmation instead of trusted. */
export const REVIEW_THRESHOLD = 0.7;

/**
 * @typedef {object} Bill
 * @property {string} id
 * @property {string} householdId
 * @property {string} providerName          - "Pacific Gas & Electric"
 * @property {string} [providerKey]         - stable slug for matching: "pge"
 * @property {string} category
 * @property {string} [accountLabel]        - last-4 or nickname, never a full account number
 * @property {number} amountDue
 * @property {string} [currency]
 * @property {string} dueDate               - ISO date
 * @property {string} [statementDate]       - ISO date
 * @property {{start: string, end: string}} [statementPeriod]
 * @property {BillStatus} status
 * @property {BillSourceType} source
 * @property {string} [sourceMessageId]     - email message id, for dedupe + traceability
 * @property {string} [sourceDocumentId]    - PDF/attachment id
 * @property {number} confidence            - 0..1
 * @property {string} detectedAt            - ISO timestamp
 * @property {string} [paidAt]
 * @property {number} [paidAmount]
 * @property {string} [paidTransactionId]   - links to the bank transaction that paid it
 * @property {string} [notes]
 * @property {Record<string, unknown>} [raw] - parser provenance; never rendered to users
 */

/**
 * Build a Bill with defaults filled in.
 * Does not validate — call `validateBill` for that, so callers can construct
 * partial bills during parsing and validate once at the boundary.
 *
 * @param {Partial<Bill>} input
 * @returns {Bill}
 */
export function makeBill(input) {
  return {
    id: input.id ?? cryptoRandomId(),
    householdId: input.householdId ?? '',
    providerName: input.providerName ?? '',
    providerKey: input.providerKey ?? slugify(input.providerName ?? ''),
    category: input.category ?? 'Other',
    accountLabel: input.accountLabel,
    amountDue: input.amountDue ?? 0,
    currency: input.currency ?? 'USD',
    dueDate: input.dueDate ?? '',
    statementDate: input.statementDate,
    statementPeriod: input.statementPeriod,
    status: input.status ?? 'detected',
    source: input.source ?? 'manual',
    sourceMessageId: input.sourceMessageId,
    sourceDocumentId: input.sourceDocumentId,
    confidence: input.confidence ?? (input.source === 'manual' ? 1 : 0),
    detectedAt: input.detectedAt ?? new Date().toISOString(),
    paidAt: input.paidAt,
    paidAmount: input.paidAmount,
    paidTransactionId: input.paidTransactionId,
    notes: input.notes,
    raw: input.raw,
  };
}

/**
 * @param {Bill} bill
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateBill(bill) {
  const errors = [];

  if (!bill.providerName) errors.push('providerName is required');
  if (!bill.householdId) errors.push('householdId is required');

  if (typeof bill.amountDue !== 'number' || Number.isNaN(bill.amountDue)) {
    errors.push('amountDue must be a number');
  } else if (bill.amountDue < 0) {
    // A credit balance is real, but it is not a bill. Surfacing it as one would
    // put a negative row in the "what's due" total.
    errors.push('amountDue must not be negative (a credit is not a bill)');
  }

  if (!isIsoDate(bill.dueDate)) errors.push('dueDate must be an ISO date (YYYY-MM-DD)');
  if (bill.statementDate && !isIsoDate(bill.statementDate)) {
    errors.push('statementDate must be an ISO date');
  }
  if (!BILL_STATUSES.includes(bill.status)) errors.push(`unknown status: ${bill.status}`);
  if (!BILL_SOURCE_TYPES.includes(bill.source)) errors.push(`unknown source: ${bill.source}`);
  if (bill.confidence < 0 || bill.confidence > 1) errors.push('confidence must be 0..1');

  // Guard against ever persisting something that looks like a full account
  // number. accountLabel is meant to hold a last-4 or a nickname.
  if (bill.accountLabel && /\d{7,}/.test(bill.accountLabel)) {
    errors.push('accountLabel looks like a full account number; store last-4 only');
  }

  return { valid: errors.length === 0, errors };
}

/** Bills below the review threshold need a human to confirm before use. */
export function needsReview(bill) {
  return bill.confidence < REVIEW_THRESHOLD && bill.source !== 'manual';
}

/** Days until due, negative when overdue. */
export function daysUntilDue(bill, asOf = new Date()) {
  const due = new Date(`${bill.dueDate}T00:00:00Z`).getTime();
  const now = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  return Math.round((due - now) / 86400000);
}

export function isUnpaid(bill) {
  return bill.status !== 'paid' && bill.status !== 'ignored';
}

/**
 * Bills due in a window. Used by the budget to answer "what's due before the
 * next paycheck", which is the question that actually drives spending decisions.
 */
export function billsDueBetween(bills, startDate, endDate) {
  return bills
    .filter((b) => isUnpaid(b) && b.dueDate >= startDate && b.dueDate < endDate)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function cryptoRandomId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `bill_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
