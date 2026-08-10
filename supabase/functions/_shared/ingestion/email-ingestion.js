// GENERATED FILE — do not edit.
// Source of truth: src/ingestion/email-ingestion.js
// Regenerate with: npm run sync:shared
/**
 * Email bill ingestion.
 *
 * Takes any `EmailProvider` (Gmail, Outlook, IMAP, or a mock) and produces
 * normalized Bills. The provider only knows how to search and fetch messages;
 * everything about recognizing a bill lives here, so a new mail backend is a
 * small adapter rather than a reimplementation.
 *
 * ## Not connected to anything yet
 *
 * No live mail provider exists in this repository. `MockEmailProvider` returns
 * fixture messages and reports `isLive: false`. Adding Gmail means writing one
 * adapter that implements the `EmailProvider` contract — nothing in this file
 * changes.
 */

import { parseBillText, htmlToText } from './bill-parser.js';
import { makeBill, needsReview, REVIEW_THRESHOLD } from '../domain/bill.js';
import { partitionBills } from './dedupe.js';

/**
 * Words that make a message worth parsing.
 * A first-pass filter only — cheap, and keeps us from running the full parser
 * over every newsletter in the mailbox.
 */
const BILL_KEYWORDS = [
  'bill', 'invoice', 'statement', 'amount due', 'payment due', 'autopay',
  'your account', 'balance', 'past due', 'e-bill', 'ebill', 'billing',
];

/**
 * Wording that means "we took your money" rather than "you owe money".
 *
 * A payment confirmation contains an amount and a date and parses beautifully
 * into a bill that is not owed — one of the more common false positives.
 *
 * These are all sentence-shaped on purpose. An earlier version matched the bare
 * label "Payment Received", which appears as a line item on most itemized
 * utility statements — so every real bill was discarded as a receipt. A label
 * in a table is not a statement about what the message is.
 */
const PAYMENT_CONFIRMATION_PATTERNS = [
  /thank you for your payment/i,
  /we(?:'ve| have)\s+received your payment/i,
  /your payment .{0,30}(was|has been) (received|applied|processed|posted)/i,
  /payment (of|in the amount of) .{0,20}(was|has been) (received|applied|processed)/i,
  /receipt for your payment/i,
  /autopay.{0,30}(was|has been)\s+(processed|applied|successful)/i,
  /payment (confirmation|receipt)\b/i,
];

/** Subject wording that settles it without reading the body. */
const CONFIRMATION_SUBJECT = /payment (received|confirmation|posted|processed)|thank you for your payment|receipt/i;

/** Language that only appears when money is still owed. */
const OWED_LANGUAGE = /amount due|total due|balance due|payment due|due date|please pay|pay by/i;

/** Marketing that mentions billing words without being a bill. */
const PROMOTIONAL_PATTERNS = [
  /unsubscribe/i, /special offer/i, /limited time/i, /save \d+%/i,
  /refer a friend/i, /survey/i,
];

/**
 * @param {import('../providers/types.js').EmailMessage} message
 * @returns {{isBill: boolean, reason: string}}
 */
export function classifyMessage(message) {
  const subject = message.subject ?? '';
  const body = message.bodyText ?? htmlToText(message.bodyHtml ?? '');
  const haystack = `${subject}\n${body}`;
  const owesMoney = OWED_LANGUAGE.test(haystack);

  // The subject is the message's own statement of what it is, so it decides
  // outright.
  if (CONFIRMATION_SUBJECT.test(subject)) {
    return { isBill: false, reason: 'payment confirmation, not a bill' };
  }

  // In the body, confirmation wording only wins when nothing says money is
  // still owed. A statement can legitimately acknowledge last month's payment
  // and bill for this month in the same document.
  const confirmationInBody = PAYMENT_CONFIRMATION_PATTERNS.some((p) => p.test(body));
  if (confirmationInBody && !owesMoney) {
    return { isBill: false, reason: 'payment confirmation, not a bill' };
  }

  const hasKeyword = BILL_KEYWORDS.some((word) => haystack.toLowerCase().includes(word));
  if (!hasKeyword) return { isBill: false, reason: 'no billing language' };

  // Promotional wording only disqualifies when nothing says money is owed,
  // since genuine bill emails often carry an unsubscribe footer.
  const promotional = PROMOTIONAL_PATTERNS.some((p) => p.test(haystack));
  if (promotional && !owesMoney) {
    return { isBill: false, reason: 'promotional message' };
  }

  return { isBill: true, reason: 'billing language present' };
}

/**
 * Derive a provider name from the sender.
 *
 * Prefers the display name ("Pacific Gas and Electric") and falls back to the
 * sending domain, stripped of the noise subdomains billing mail is sent from
 * ("billing.pge.com" -> "pge").
 */
export function providerFromSender(message) {
  const displayName = (message.fromName ?? '').trim();
  if (displayName && !/^no.?reply/i.test(displayName) && !displayName.includes('@')) {
    return displayName;
  }

  const match = (message.from ?? '').match(/@([^>\s]+)/);
  if (!match) return 'Unknown provider';

  const parts = match[1].toLowerCase().split('.');
  const noise = new Set(['billing', 'mail', 'email', 'e', 'no-reply', 'noreply', 'notifications', 'my', 'secure']);
  const meaningful = parts.filter((p) => !noise.has(p) && !['com', 'net', 'org', 'co', 'us'].includes(p));

  const name = meaningful[0] ?? parts[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Ingest bills from an email provider.
 *
 * @param {import('../providers/types.js').EmailProvider} provider
 * @param {object} options
 * @param {string} options.householdId
 * @param {string} [options.since]        - ISO date
 * @param {object[]} [options.existingBills] - for duplicate detection
 * @param {string[]} [options.fromDomains]
 * @param {number} [options.limit]
 * @returns {Promise<IngestResult>}
 */
export async function ingestBillsFromEmail(provider, options) {
  /** @type {IngestResult} */
  const result = {
    provider: provider.info.key,
    isLive: provider.info.isLive,
    messagesScanned: 0,
    messagesClassifiedAsBills: 0,
    billsParsed: 0,
    billsAccepted: [],
    duplicates: [],
    needsReview: [],
    skipped: [],
    errors: [],
  };

  const connected = await provider.isConnected();
  if (!connected) {
    result.errors.push({
      stage: 'connect',
      message: `${provider.info.displayName} is not connected`,
    });
    return result;
  }

  let messages;
  try {
    messages = await provider.searchMessages({
      since: options.since,
      keywords: BILL_KEYWORDS,
      fromDomains: options.fromDomains,
      limit: options.limit ?? 200,
    });
  } catch (error) {
    result.errors.push({ stage: 'search', message: error.message });
    return result;
  }

  result.messagesScanned = messages.length;
  const candidates = [];

  for (const message of messages) {
    try {
      const verdict = classifyMessage(message);
      if (!verdict.isBill) {
        result.skipped.push({ messageId: message.id, subject: message.subject, reason: verdict.reason });
        continue;
      }
      result.messagesClassifiedAsBills++;

      const text = message.bodyText?.trim()
        ? message.bodyText
        : htmlToText(message.bodyHtml ?? '');

      const providerName = options.providerNameOverride ?? providerFromSender(message);
      const fields = parseBillText(text, {
        subject: message.subject,
        fromAddress: message.from,
        providerName,
      });

      // An amount and a due date are the minimum useful bill. Without both, the
      // budget cannot say what is owed or when, so it is not stored as a bill —
      // it is reported as a message we could not parse, which is honest and
      // actionable in a way a half-filled row is not.
      if (fields.amountDue == null || !fields.dueDate) {
        result.skipped.push({
          messageId: message.id,
          subject: message.subject,
          reason: `incomplete parse (${fields.warnings.join('; ') || 'missing amount or due date'})`,
        });
        continue;
      }

      result.billsParsed++;
      candidates.push(makeBill({
        householdId: options.householdId,
        providerName,
        category: fields.category,
        accountLabel: fields.accountLabel,
        amountDue: fields.amountDue,
        dueDate: fields.dueDate,
        statementDate: fields.statementDate,
        statementPeriod: fields.statementPeriod,
        status: 'detected',
        source: 'email',
        sourceMessageId: message.id,
        confidence: fields.confidence,
        detectedAt: new Date().toISOString(),
        raw: { amountLabel: fields.amountLabel, warnings: fields.warnings, subject: message.subject },
      }));
    } catch (error) {
      result.errors.push({ stage: 'parse', messageId: message.id, message: error.message });
    }
  }

  const { accepted, duplicates } = partitionBills(candidates, options.existingBills ?? []);
  result.duplicates = duplicates;

  // Low-confidence bills are separated rather than dropped. They are real
  // information; they just must not silently move a budget total until someone
  // has looked at them.
  for (const bill of accepted) {
    if (needsReview(bill)) result.needsReview.push(bill);
    else result.billsAccepted.push(bill);
  }

  return result;
}

/**
 * @typedef {object} IngestResult
 * @property {string} provider
 * @property {boolean} isLive
 * @property {number} messagesScanned
 * @property {number} messagesClassifiedAsBills
 * @property {number} billsParsed
 * @property {object[]} billsAccepted
 * @property {object[]} duplicates
 * @property {object[]} needsReview
 * @property {object[]} skipped
 * @property {object[]} errors
 */

export { REVIEW_THRESHOLD };
