// GENERATED FILE — do not edit.
// Source of truth: src/ingestion/dedupe.js
// Regenerate with: npm run sync:shared
/**
 * Duplicate detection for imported bills and paystubs.
 *
 * Duplicates are not an edge case here — they are the normal consequence of
 * automation working correctly. A single electric bill arrives as an email
 * notification, again as a PDF attachment, again from the provider's API, and
 * again on every re-sync of an overlapping window. Without dedupe the household
 * sees the same $186 bill four times and their "due before payday" total is
 * four times too high.
 *
 * Three tiers, strongest first:
 *
 *   1. **Source identity.** Same message id or provider record id. Certain.
 *   2. **Business identity.** Same provider, same due date, same amount. A
 *      provider does not bill the same amount on the same date twice.
 *   3. **Fuzzy.** Same provider, near-identical amount, due dates within a few
 *      days. Catches the same bill seen through two different channels that
 *      disagree slightly on the date. Reported as a probable duplicate rather
 *      than merged silently, because occasionally it is two real bills.
 */

import { providersMatch } from '../domain/provider-match.js';

/** Due dates this far apart may still be the same bill seen twice. */
const FUZZY_DAY_WINDOW = 3;

/** Amounts within this fraction are treated as the same figure. */
const FUZZY_AMOUNT_TOLERANCE = 0.01;

/**
 * Stable key for a bill's business identity.
 * Used as a database unique constraint as well as an in-memory check.
 */
export function billIdentityKey(bill) {
  const provider = (bill.providerKey || bill.providerName || '').toLowerCase();
  const amount = Number(bill.amountDue ?? 0).toFixed(2);
  return `${bill.householdId}|${provider}|${bill.dueDate}|${amount}`;
}

/** Stable key for a bill's source, when it has one. */
export function billSourceKey(bill) {
  const ref = bill.sourceMessageId || bill.sourceDocumentId;
  return ref ? `${bill.householdId}|${bill.source}|${ref}` : null;
}

/**
 * @typedef {object} DuplicateVerdict
 * @property {boolean} isDuplicate
 * @property {'source'|'identity'|'fuzzy'|null} matchType
 * @property {object|null} existing
 * @property {number} confidence
 * @property {string} [reason]
 */

/**
 * Check one candidate bill against bills already stored.
 *
 * @param {object} candidate
 * @param {object[]} existingBills
 * @returns {DuplicateVerdict}
 */
export function findDuplicateBill(candidate, existingBills) {
  const none = { isDuplicate: false, matchType: null, existing: null, confidence: 0 };
  if (!existingBills?.length) return none;

  // 1. Same source record. Certain.
  const sourceKey = billSourceKey(candidate);
  if (sourceKey) {
    const match = existingBills.find((b) => billSourceKey(b) === sourceKey);
    if (match) {
      return {
        isDuplicate: true, matchType: 'source', existing: match, confidence: 1,
        reason: 'same source message/document already imported',
      };
    }
  }

  // 2. Same provider, date, and amount.
  const identityKey = billIdentityKey(candidate);
  const identityMatch = existingBills.find((b) => billIdentityKey(b) === identityKey);
  if (identityMatch) {
    return {
      isDuplicate: true, matchType: 'identity', existing: identityMatch, confidence: 0.97,
      reason: 'same provider, due date and amount',
    };
  }

  // 3. Fuzzy — same provider (allowing for how differently each channel
  // spells it: "netflix" from a manual entry vs "netflixcom" from a Gmail
  // parse are the same company), close amount, close date.
  const candidateProvider = candidate.providerKey || candidate.providerName || '';
  for (const existing of existingBills) {
    const existingProvider = existing.providerKey || existing.providerName || '';
    if (!providersMatch(candidateProvider, existingProvider)) continue;
    if (existing.householdId !== candidate.householdId) continue;

    const amountDelta = Math.abs(existing.amountDue - candidate.amountDue);
    const relative = candidate.amountDue ? amountDelta / candidate.amountDue : 1;
    if (relative > FUZZY_AMOUNT_TOLERANCE) continue;

    const dayDelta = daysBetween(existing.dueDate, candidate.dueDate);
    if (dayDelta > FUZZY_DAY_WINDOW) continue;

    return {
      isDuplicate: true, matchType: 'fuzzy', existing, confidence: 0.75,
      reason: `same provider, amount within ${(relative * 100).toFixed(1)}%, due dates ${dayDelta} day(s) apart`,
    };
  }

  return none;
}

/**
 * Split a batch into new bills and duplicates.
 *
 * Compares against already-accepted candidates too, so a single batch
 * containing the same bill twice — an email and its own PDF attachment — does
 * not insert both.
 *
 * @param {object[]} candidates
 * @param {object[]} existingBills
 */
export function partitionBills(candidates, existingBills = []) {
  const accepted = [];
  const duplicates = [];
  const pool = [...existingBills];

  for (const candidate of candidates) {
    const verdict = findDuplicateBill(candidate, pool);
    if (verdict.isDuplicate) {
      duplicates.push({ candidate, ...verdict });
    } else {
      accepted.push(candidate);
      pool.push(candidate);
    }
  }

  return { accepted, duplicates };
}

/**
 * Decide whether a duplicate should nonetheless update the stored bill.
 *
 * Re-seeing a bill is often an improvement rather than noise: the PDF carries
 * an exact amount where the email teaser was vague, or the provider API
 * confirms what a parser guessed. Higher-confidence and more authoritative
 * sources win.
 */
const SOURCE_AUTHORITY = { provider_api: 4, pdf: 3, provider_portal: 2, email: 1, manual: 5 };

export function shouldUpdateExisting(existing, candidate) {
  // A human's entry is never overwritten by a parser.
  if (existing.source === 'manual' && candidate.source !== 'manual') {
    return { update: false, reason: 'existing bill was entered manually' };
  }
  // Nor is a confirmed or paid bill silently rewritten.
  if (existing.status === 'paid') {
    return { update: false, reason: 'bill is already paid' };
  }

  const existingAuthority = SOURCE_AUTHORITY[existing.source] ?? 0;
  const candidateAuthority = SOURCE_AUTHORITY[candidate.source] ?? 0;

  if (candidateAuthority > existingAuthority) {
    return { update: true, reason: `${candidate.source} is more authoritative than ${existing.source}` };
  }
  if (candidateAuthority === existingAuthority && candidate.confidence > existing.confidence + 0.05) {
    return { update: true, reason: 'same source type parsed with higher confidence' };
  }
  return { update: false, reason: 'existing record is at least as trustworthy' };
}

/**
 * Paystub identity.
 *
 * Keyed on pay date and period rather than amount: two paychecks can legitimately
 * be identical amounts, but not for the same period.
 */
export function paystubIdentityKey(stub) {
  return `${stub.householdId}|${stub.payProfileId ?? 'default'}|${stub.payDate}|${stub.period?.start ?? ''}`;
}

export function findDuplicatePaystub(candidate, existing) {
  if (!existing?.length) {
    return { isDuplicate: false, matchType: null, existing: null, confidence: 0 };
  }

  if (candidate.sourceRef) {
    const match = existing.find((s) => s.sourceRef && s.sourceRef === candidate.sourceRef);
    if (match) {
      return { isDuplicate: true, matchType: 'source', existing: match, confidence: 1 };
    }
  }

  const key = paystubIdentityKey(candidate);
  const match = existing.find((s) => paystubIdentityKey(s) === key);
  if (match) {
    return {
      isDuplicate: true, matchType: 'identity', existing: match, confidence: 0.97,
      reason: 'same pay date and period',
    };
  }

  return { isDuplicate: false, matchType: null, existing: null, confidence: 0 };
}

/**
 * Time entry identity — one entry per profile per day per source.
 * Re-importing a timecard must correct the day, not append a second one.
 */
export function timeEntryIdentityKey(entry) {
  return `${entry.householdId}|${entry.payProfileId ?? 'default'}|${entry.date}`;
}

function daysBetween(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs(
    (new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000,
  );
}
