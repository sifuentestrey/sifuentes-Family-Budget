/**
 * Generic bill parser.
 *
 * Extracts amount due, due date, statement date, and account label from bill
 * text — email body, PDF text layer, or portal HTML — using the language bills
 * actually use, rather than templates for named companies.
 *
 * Deliberately provider-agnostic. Provider-specific quirks belong in adapters
 * under `src/providers/`, which can override or post-process what this returns.
 * Hard-coding one utility here would mean every new provider requires editing
 * core parsing logic, which is exactly the coupling this design avoids.
 *
 * ## Why label priority matters
 *
 * A utility bill commonly contains several dollar figures: the current charges,
 * the previous balance, a payment received, a late fee, and the total now due.
 * Grabbing the largest, or the first, gets it wrong regularly. Labels are
 * therefore ranked, and the highest-ranked label present wins — "Total Amount
 * Due" beats "Current Charges" beats a bare "Amount".
 */

import { parseDate, findLabelledDate } from './date-parser.js';

/**
 * Amount labels in priority order. Earlier entries are more likely to be the
 * figure the household actually owes.
 */
const AMOUNT_LABELS = [
  { label: 'total amount due', weight: 1.0 },
  { label: 'total due', weight: 1.0 },
  { label: 'amount due', weight: 0.98 },
  { label: 'please pay', weight: 0.95 },
  { label: 'balance due', weight: 0.92 },
  { label: 'payment due', weight: 0.92 },
  { label: 'total balance', weight: 0.88 },
  { label: 'new balance', weight: 0.88 },
  { label: 'current charges', weight: 0.82 },
  { label: 'current amount due', weight: 0.9 },
  { label: 'statement balance', weight: 0.85 },
  { label: 'minimum payment due', weight: 0.75 },
  { label: 'minimum payment', weight: 0.72 },
  { label: 'total', weight: 0.5 },
  { label: 'amount', weight: 0.45 },
];

const DUE_DATE_LABELS = [
  'payment due date', 'due date', 'payment due by', 'payment due',
  'due by', 'due on', 'pay by',
];

const STATEMENT_DATE_LABELS = [
  'statement date', 'bill date', 'billing date', 'invoice date', 'issued',
];

const PERIOD_LABELS = [
  'service period', 'billing period', 'statement period', 'usage period',
  'service from', 'billing cycle',
];

const ACCOUNT_LABELS = [
  'account number', 'account #', 'account no', 'acct #', 'acct no',
  'account ending in', 'account ending',
];

/**
 * Figures that are explicitly NOT what is owed. If one of these labels sits
 * immediately before a number, that number is excluded from consideration —
 * without this, "Previous Balance $240.00 / Payment Received -$240.00 / Amount
 * Due $86.12" frequently yields 240.
 */
const NEGATIVE_LABELS = [
  'previous balance', 'prior balance', 'last payment', 'payment received',
  'payments received', 'credit', 'adjustment', 'amount paid', 'paid to date',
  'budget billing', 'deposit',
];

/** Category inference from provider/subject wording. Overridable per adapter. */
const CATEGORY_HINTS = [
  [/electric|energy|power|gas & electric|utilit/i, 'Utilities'],
  [/water|sewer|sanitation|waste|garbage|recycl/i, 'Utilities'],
  [/natural gas|gas compan/i, 'Utilities'],
  [/internet|broadband|fiber|cable|wireless|mobile|phone|telecom/i, 'Internet/Phone'],
  [/rent|lease|property manage|landlord/i, 'Rent/Mortgage'],
  [/mortgage|home ?loan|escrow/i, 'Rent/Mortgage'],
  [/auto ?insur|car ?insur|vehicle ?insur/i, 'Car Insurance'],
  [/health ?insur|medical ?plan|dental ?plan/i, 'Health Insurance'],
  [/insur|policy premium/i, 'Insurance'],
  [/auto ?loan|car ?payment|vehicle ?loan/i, 'Car Payment'],
  [/daycare|childcare|preschool|early learning/i, 'Childcare'],
  [/hospital|clinic|medical|physician|dental|orthodont/i, 'Medical'],
  [/tax|assessor|treasurer|revenue/i, 'Taxes'],
  [/subscription|membership|streaming/i, 'Subscriptions'],
];

/**
 * @typedef {object} ParsedBillFields
 * @property {number} [amountDue]
 * @property {string} [amountLabel]      - which label produced the amount
 * @property {string} [dueDate]
 * @property {string} [statementDate]
 * @property {{start: string, end: string}} [statementPeriod]
 * @property {string} [accountLabel]     - last-4 only
 * @property {string} [category]
 * @property {number} confidence
 * @property {string[]} warnings
 */

/**
 * Parse bill fields out of text.
 *
 * @param {string} text
 * @param {object} [context]
 * @param {string} [context.subject]
 * @param {string} [context.fromAddress]
 * @param {string} [context.providerName]
 * @param {'US'|'ISO'|'EU'} [context.locale]
 * @returns {ParsedBillFields}
 */
export function parseBillText(text, context = {}) {
  const warnings = [];
  if (!text || !text.trim()) {
    return { confidence: 0, warnings: ['empty document'] };
  }

  const normalized = normalizeWhitespace(text);
  const haystack = `${context.subject ?? ''}\n${normalized}`;

  const amount = extractAmount(normalized, warnings);
  const statement = findLabelledDate(normalized, STATEMENT_DATE_LABELS, {
    locale: context.locale,
  });
  const due = findLabelledDate(normalized, DUE_DATE_LABELS, {
    locale: context.locale,
    // Anchoring to the statement date fixes the "Due January 5" on a December
    // bill case, which otherwise lands eleven months in the past.
    referenceDate: statement?.iso,
  });

  const period = extractPeriod(normalized, context.locale, statement?.iso);
  const accountLabel = extractAccountLabel(normalized);
  const category = inferCategory(`${context.providerName ?? ''} ${haystack}`);

  const confidence = scoreConfidence({ amount, due, statement, warnings });

  if (!amount) warnings.push('no amount due found');
  if (!due) warnings.push('no due date found');
  if (due?.ambiguous) {
    warnings.push(`due date ${due.iso} used an ambiguous numeric format; day/month order is a guess`);
  }
  if (due && statement && due.iso < statement.iso) {
    warnings.push('due date precedes statement date; one of them is likely misread');
  }

  return {
    amountDue: amount?.value,
    amountLabel: amount?.label,
    dueDate: due?.iso,
    statementDate: statement?.iso,
    statementPeriod: period ?? undefined,
    accountLabel: accountLabel ?? undefined,
    category,
    confidence,
    warnings,
  };
}

/**
 * Find the amount owed.
 *
 * Scans every labelled money figure, discards ones preceded by a
 * "this-is-not-what-you-owe" label, and keeps the highest-weighted match.
 */
function extractAmount(text, warnings) {
  const candidates = [];

  for (const { label, weight } of AMOUNT_LABELS) {
    // Money may be separated from its label by punctuation or dot leaders
    // ("Total Amount Due ................ $86.12").
    //
    // The separator class deliberately excludes "-". Including it made the
    // class consume the minus in "Total Amount Due -$45.00", so a credit
    // balance parsed as a positive $45 bill the household does not owe.
    // The sign is part of the number and is captured with it.
    const pattern = new RegExp(
      `${escapeRegex(label)}\\s*[:.·•]*\\s*(\\(?\\s*-?\\s*\\$?\\s*-?[\\d,]+(?:\\.\\d{2})?\\s*\\)?)`,
      'gi',
    );

    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = parseMoney(match[1]);
      if (value === null) continue;

      // Look back only to the start of the current line.
      //
      // A fixed character window reaches into the previous row of a statement,
      // where "Payment Received -$186.44" sits directly above "Total Amount Due
      // $203.17". That made every itemized utility bill discard its own total.
      const lineStart = text.lastIndexOf('\n', match.index) + 1;
      const before = text.slice(lineStart, match.index).toLowerCase();
      if (NEGATIVE_LABELS.some((neg) => before.includes(neg))) continue;

      // A credit balance is not a bill. Recording it as one would put a
      // negative row into "what's due".
      if (value < 0) {
        warnings.push(`ignored negative amount ${value} for "${label}" (credit balance)`);
        continue;
      }

      candidates.push({ value, label, weight, index: match.index });
    }
  }

  if (!candidates.length) return null;

  // Highest weight wins; ties break toward the later occurrence, since totals
  // are typically stated at the end of a statement.
  candidates.sort((a, b) => b.weight - a.weight || b.index - a.index);

  const best = candidates[0];
  const rivals = candidates.filter(
    (c) => c.weight === best.weight && Math.abs(c.value - best.value) > 0.005,
  );
  if (rivals.length) {
    warnings.push(
      `multiple conflicting values for "${best.label}": ${[...new Set([best.value, ...rivals.map((r) => r.value)])].join(', ')}`,
    );
  }

  return best;
}

function extractPeriod(text, locale, referenceDate) {
  for (const label of PERIOD_LABELS) {
    const pattern = new RegExp(`${escapeRegex(label)}\\s*[:\\-–—]?\\s*([^\\n\\r]{0,60})`, 'i');
    const match = text.match(pattern);
    if (!match) continue;

    // "Jan 3 - Feb 2, 2026" / "01/03/2026 to 02/02/2026"
    const parts = match[1].split(/\s+(?:to|through|thru|until|-|–|—)\s+/i);
    if (parts.length < 2) continue;

    const start = parseDate(parts[0], { locale, referenceDate });
    const end = parseDate(parts[1], { locale, referenceDate });
    if (start && end) return { start: start.iso, end: end.iso };
  }
  return null;
}

/**
 * Extract an account identifier, reduced to its last 4 characters.
 *
 * Never returns a full account number. Storing one buys nothing — the household
 * already knows their account — and turns a budget database into something
 * worth stealing.
 */
function extractAccountLabel(text) {
  for (const label of ACCOUNT_LABELS) {
    const pattern = new RegExp(
      `${escapeRegex(label)}\\s*[:#\\-]?\\s*([\\dXx*•\\-]{3,25})`,
      'i',
    );
    const match = text.match(pattern);
    if (!match) continue;

    const digits = match[1].replace(/[^\dXx*]/g, '');
    if (digits.length < 3) continue;
    return digits.slice(-4);
  }
  return null;
}

function inferCategory(text) {
  for (const [pattern, category] of CATEGORY_HINTS) {
    if (pattern.test(text)) return category;
  }
  return 'Other';
}

/**
 * Overall confidence in the parse.
 *
 * The amount and the due date are what the budget consumes, so the score is
 * driven almost entirely by whether both were found and how cleanly. Anything
 * missing an amount is near-zero regardless of what else was extracted — a bill
 * whose amount we guessed at is not usable.
 */
function scoreConfidence({ amount, due, statement, warnings }) {
  if (!amount) return 0.1;

  let score = 0.35 + amount.weight * 0.3;

  if (due) score += due.confidence * 0.25;
  else score -= 0.15;

  if (statement) score += 0.1;

  // Each unresolved warning shaves confidence, pushing genuinely messy parses
  // below the review threshold rather than through it.
  score -= warnings.length * 0.05;

  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

/**
 * Parse a captured money string.
 * Handles "$1,428.00", "-$45.00", "$-45.00", and the accounting form "($45.00)",
 * all of which appear on real statements to mean a credit.
 */
function parseMoney(raw) {
  const text = raw.trim();
  const negative = text.includes('-') || (text.startsWith('(') && text.endsWith(')'));

  const digits = text.replace(/[^\d.]/g, '');
  if (!digits) return null;

  const value = Number.parseFloat(digits);
  if (Number.isNaN(value)) return null;

  return Math.round((negative ? -value : value) * 100) / 100;
}

function normalizeWhitespace(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]{2,}/g, ' ');
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip HTML to text before parsing.
 * Most bill emails are HTML; the fields we want are in the visible text.
 */
export function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h\d|li)>/gi, '\n')
    // Table cells become spaces so "Amount Due</td><td>$86.12" stays on one line
    // and the label-to-value regexes still match.
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(+code))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
