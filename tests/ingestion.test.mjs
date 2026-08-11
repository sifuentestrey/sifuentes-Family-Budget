/**
 * Bill parsing, date extraction, duplicate detection, email ingestion,
 * sync engine, and safe-to-spend.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBillText, htmlToText } from '../src/ingestion/bill-parser.js';
import { parseDate, findLabelledDate } from '../src/ingestion/date-parser.js';
import {
  findDuplicateBill, partitionBills, shouldUpdateExisting,
  billIdentityKey, findDuplicatePaystub,
} from '../src/ingestion/dedupe.js';
import { ingestBillsFromEmail, classifyMessage, providerFromSender } from '../src/ingestion/email-ingestion.js';
import { makeBill, validateBill, needsReview, billsDueBetween } from '../src/domain/bill.js';
import { providersMatch } from '../src/domain/provider-match.js';
import { createMockEmailProvider, MOCK_MESSAGES } from '../src/providers/mock/mock-email-provider.js';
import { createMockPayrollProvider } from '../src/providers/mock/mock-payroll-provider.js';
import { createRegistry } from '../src/providers/registry.js';
import { syncBills, syncPayroll, syncPaystubs, createMemoryStore, summarizeSyncState } from '../src/sync/sync-engine.js';
import { calculateSafeToSpend, monthlyOverview } from '../src/engine/budget/safe-to-spend.js';

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

test('ISO dates parse with full confidence', () => {
  const result = parseDate('2026-08-08');
  assert.equal(result.iso, '2026-08-08');
  assert.equal(result.confidence, 1);
  assert.equal(result.ambiguous, false);
});

test('month-name dates parse in either order', () => {
  assert.equal(parseDate('August 8, 2026').iso, '2026-08-08');
  assert.equal(parseDate('8 August 2026').iso, '2026-08-08');
  assert.equal(parseDate('Aug 8 2026').iso, '2026-08-08');
});

test('a day over 12 resolves the order regardless of locale', () => {
  // 25 cannot be a month, so this is unambiguous even in a US-first parser.
  const result = parseDate('25/08/2026', { locale: 'US' });
  assert.equal(result.iso, '2026-08-25');
  assert.equal(result.ambiguous, false);
});

test('a genuinely ambiguous numeric date is flagged and penalised', () => {
  // 03/04 is March 4th in the US and April 3rd elsewhere. There is no way to
  // know from the string, so confidence must drop below the review threshold.
  const us = parseDate('03/04/2026', { locale: 'US' });
  const eu = parseDate('03/04/2026', { locale: 'EU' });
  assert.equal(us.iso, '2026-03-04');
  assert.equal(eu.iso, '2026-04-03');
  assert.ok(us.ambiguous);
  assert.ok(us.confidence < 0.7, 'must fall below the review threshold');
});

test('a missing year is inferred from the statement date, not the current year', () => {
  // A December statement naming "January 5" means next January.
  const result = parseDate('January 5', { referenceDate: '2026-12-20' });
  assert.equal(result.iso, '2027-01-05');
  assert.equal(result.yearInferred, true);
});

test('impossible dates are rejected rather than rolled over', () => {
  // Date() would silently turn Feb 30 into March 2.
  assert.equal(parseDate('2026-02-30'), null);
  assert.equal(parseDate('February 30, 2026'), null);
});

test('a labelled date does not capture a value from another line', () => {
  const text = 'Statement Date: 2026-07-17\nDue Date: 2026-08-08';
  assert.equal(findLabelledDate(text, ['Statement Date']).iso, '2026-07-17');
  assert.equal(findLabelledDate(text, ['Due Date']).iso, '2026-08-08');
});

// ---------------------------------------------------------------------------
// Bill parsing
// ---------------------------------------------------------------------------

const UTILITY_BILL = [
  'Account Number: ****8842',
  'Statement Date: July 17, 2026',
  'Service Period: June 16, 2026 to July 15, 2026',
  'Previous Balance          $186.44',
  'Payment Received         -$186.44',
  'Current Charges           $203.17',
  'Total Amount Due          $203.17',
  'Payment Due Date: August 8, 2026',
].join('\n');

test('the amount owed is taken over other dollar figures on the page', () => {
  // A utility bill lists previous balance, payments, and current charges.
  // Grabbing the first or largest gets it wrong regularly.
  const result = parseBillText(UTILITY_BILL);
  assert.equal(result.amountDue, 203.17);
  assert.equal(result.amountLabel, 'total amount due');
});

test('a previous balance is never mistaken for the amount due', () => {
  const text = 'Previous Balance $500.00\nAmount Due $86.12\nDue Date: 2026-08-01';
  assert.equal(parseBillText(text).amountDue, 86.12);
});

test('due date, statement date and period are all extracted', () => {
  const result = parseBillText(UTILITY_BILL);
  assert.equal(result.dueDate, '2026-08-08');
  assert.equal(result.statementDate, '2026-07-17');
  assert.deepEqual(result.statementPeriod, { start: '2026-06-16', end: '2026-07-15' });
});

test('only the last 4 of an account number is retained', () => {
  const result = parseBillText('Account Number: 4455667788842\nAmount Due $10.00\nDue Date: 2026-08-01');
  assert.equal(result.accountLabel, '8842');
  assert.ok(!JSON.stringify(result).includes('4455667788842'), 'full number must never survive parsing');
});

test('a credit balance is not reported as a bill', () => {
  const result = parseBillText('Total Amount Due -$45.00\nDue Date: 2026-08-01');
  assert.equal(result.amountDue, undefined);
  assert.ok(result.warnings.some((w) => /credit balance/.test(w)));
});

test('category is inferred from wording, not a hard-coded provider list', () => {
  assert.equal(parseBillText('Amount Due $1\nDue Date: 2026-08-01', { providerName: 'Anytown Electric Co-op' }).category, 'Utilities');
  assert.equal(parseBillText('Amount Due $1\nDue Date: 2026-08-01', { providerName: 'Fastnet Broadband' }).category, 'Internet/Phone');
  assert.equal(parseBillText('Amount Due $1\nDue Date: 2026-08-01', { providerName: 'Little Acorns Daycare' }).category, 'Childcare');
});

test('confidence drops when the amount or due date is missing', () => {
  const complete = parseBillText(UTILITY_BILL);
  const noDate = parseBillText('Total Amount Due $203.17');
  const nothing = parseBillText('Hello, your statement is ready.');

  assert.ok(complete.confidence > 0.8);
  assert.ok(noDate.confidence < complete.confidence);
  assert.ok(nothing.confidence < 0.2);
});

test('HTML table bills parse after conversion to text', () => {
  const html = '<table><tr><td>Balance Due</td><td>$74.20</td></tr><tr><td>Due Date</td><td>2026-08-05</td></tr></table>';
  const result = parseBillText(htmlToText(html));
  assert.equal(result.amountDue, 74.2);
  assert.equal(result.dueDate, '2026-08-05');
});

test('a due date before the statement date is flagged as suspect', () => {
  const text = 'Statement Date: 2026-08-20\nAmount Due $50.00\nDue Date: 2026-08-01';
  const result = parseBillText(text);
  assert.ok(result.warnings.some((w) => /precedes statement date/.test(w)));
});

// ---------------------------------------------------------------------------
// Message classification
// ---------------------------------------------------------------------------

test('a payment confirmation is not treated as a bill', () => {
  // It contains an amount and a date and parses beautifully into a bill that
  // is not owed — one of the most common false positives.
  const message = MOCK_MESSAGES.find((m) => m.id === 'msg_confirmation_003');
  const verdict = classifyMessage(message);
  assert.equal(verdict.isBill, false);
  assert.match(verdict.reason, /payment confirmation/);
});

test('marketing using billing words is rejected', () => {
  const message = MOCK_MESSAGES.find((m) => m.id === 'msg_promo_004');
  assert.equal(classifyMessage(message).isBill, false);
});

test('a real bill is accepted', () => {
  const message = MOCK_MESSAGES.find((m) => m.id === 'msg_utility_001');
  assert.equal(classifyMessage(message).isBill, true);
});

test('provider name comes from the display name or a cleaned domain', () => {
  assert.equal(providerFromSender({ fromName: 'Example Power & Light', from: 'a@b.com' }), 'Example Power & Light');
  // Noise subdomains are stripped.
  assert.equal(providerFromSender({ from: 'billing@examplepower.com', fromName: 'no-reply' }), 'Examplepower');
});

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

const bill = (overrides) => makeBill({
  householdId: 'h1', providerName: 'Example Power', category: 'Utilities',
  amountDue: 203.17, dueDate: '2026-08-08', source: 'email', confidence: 0.9, ...overrides,
});

test('the same source message is a certain duplicate', () => {
  const first = bill({ sourceMessageId: 'msg_1' });
  const verdict = findDuplicateBill(bill({ sourceMessageId: 'msg_1' }), [first]);
  assert.equal(verdict.isDuplicate, true);
  assert.equal(verdict.matchType, 'source');
  assert.equal(verdict.confidence, 1);
});

test('same provider, date and amount is a duplicate even from another channel', () => {
  const first = bill({ sourceMessageId: 'msg_1', source: 'email' });
  const second = bill({ sourceMessageId: 'msg_2', source: 'pdf' });
  const verdict = findDuplicateBill(second, [first]);
  assert.equal(verdict.matchType, 'identity');
});

test('a near-identical bill a couple of days apart is caught fuzzily', () => {
  const first = bill({ sourceMessageId: 'msg_1', dueDate: '2026-08-08' });
  const second = bill({ sourceMessageId: 'msg_2', dueDate: '2026-08-10', amountDue: 203.17 });
  const verdict = findDuplicateBill(second, [first]);
  assert.equal(verdict.matchType, 'fuzzy');
  assert.ok(verdict.confidence < 1, 'fuzzy matches are reported, not asserted');
});

test('two genuinely different bills from one provider are both kept', () => {
  const july = bill({ sourceMessageId: 'm1', dueDate: '2026-07-08', amountDue: 186.44 });
  const august = bill({ sourceMessageId: 'm2', dueDate: '2026-08-08', amountDue: 203.17 });
  assert.equal(findDuplicateBill(august, [july]).isDuplicate, false);
});

test('duplicates within a single batch are caught', () => {
  const batch = [bill({ sourceMessageId: 'm1' }), bill({ sourceMessageId: 'm2' })];
  const { accepted, duplicates } = partitionBills(batch, []);
  assert.equal(accepted.length, 1);
  assert.equal(duplicates.length, 1);
});

test('a more authoritative source updates the stored bill', () => {
  const fromEmail = bill({ source: 'email', confidence: 0.7 });
  const fromApi = bill({ source: 'provider_api', confidence: 1 });
  assert.equal(shouldUpdateExisting(fromEmail, fromApi).update, true);
  assert.equal(shouldUpdateExisting(fromApi, fromEmail).update, false);
});

test('a manually entered bill is never overwritten by a parser', () => {
  const manual = bill({ source: 'manual', confidence: 1 });
  const parsed = bill({ source: 'provider_api', confidence: 1 });
  assert.equal(shouldUpdateExisting(manual, parsed).update, false);
});

test('a paid bill is not rewritten', () => {
  const paid = bill({ source: 'email', status: 'paid' });
  assert.equal(shouldUpdateExisting(paid, bill({ source: 'provider_api' })).update, false);
});

test('identity keys are stable and scoped to the household', () => {
  assert.equal(billIdentityKey(bill({ id: 'a' })), billIdentityKey(bill({ id: 'b' })));
  assert.notEqual(billIdentityKey(bill()), billIdentityKey(bill({ householdId: 'h2' })));
});

test('a bill entered by hand catches a Gmail-parsed duplicate despite a differently spelled provider key', () => {
  // The exact scenario manual entry introduced: a household types "Netflix"
  // for a bill the Gmail parser already stored under the key "netflixcom".
  const parsed = bill({
    providerName: 'Netflix.com', providerKey: 'netflixcom', source: 'email',
    sourceMessageId: 'msg_1', dueDate: '2026-08-08', amountDue: 17.99,
  });
  const typed = bill({
    providerName: 'Netflix', providerKey: 'netflix', source: 'manual',
    dueDate: '2026-08-09', amountDue: 17.99, confidence: 1,
  });
  const verdict = findDuplicateBill(typed, [parsed]);
  assert.equal(verdict.isDuplicate, true);
  assert.equal(verdict.matchType, 'fuzzy');
});

test('a manual entry updates the Gmail-parsed duplicate rather than sitting alongside it', () => {
  const parsed = bill({ providerKey: 'netflixcom', providerName: 'Netflix.com', source: 'email', confidence: 0.85 });
  const typed = bill({ providerKey: 'netflix', providerName: 'Netflix', source: 'manual', confidence: 1 });
  assert.equal(shouldUpdateExisting(parsed, typed).update, true);
});

test('unrelated providers of similar length are not fuzzy-matched', () => {
  const gas = bill({ providerKey: 'texas-gas', providerName: 'Texas Gas' });
  const power = bill({ providerKey: 'texas-power', providerName: 'Texas Power', amountDue: gas.amountDue, dueDate: gas.dueDate });
  assert.equal(findDuplicateBill(power, [gas]).isDuplicate, false);
});

// ---------------------------------------------------------------------------
// Provider name fuzzy matching
// ---------------------------------------------------------------------------

test('providersMatch treats spelling variants of one company as the same', () => {
  assert.ok(providersMatch('Netflix', 'netflixcom'));
  assert.ok(providersMatch('Netflix.com', 'Netflix'));
  assert.ok(providersMatch('Con Edison', 'CON EDISON'));
});

test('providersMatch rejects different companies, including short-name collisions', () => {
  assert.ok(!providersMatch('AT&T', 'AAA'));
  assert.ok(!providersMatch('Texas Gas', 'Texas Power'));
  assert.ok(!providersMatch('', 'Netflix'));
});

test('paystubs dedupe on pay date and period, not amount', () => {
  const stub = { householdId: 'h1', payDate: '2026-08-07', period: { start: '2026-07-20', end: '2026-08-02' } };
  assert.equal(findDuplicatePaystub({ ...stub }, [stub]).isDuplicate, true);
  // Two identical amounts in different periods are two real paychecks.
  const other = { ...stub, payDate: '2026-08-21', period: { start: '2026-08-03', end: '2026-08-16' } };
  assert.equal(findDuplicatePaystub(other, [stub]).isDuplicate, false);
});

// ---------------------------------------------------------------------------
// Email ingestion end to end
// ---------------------------------------------------------------------------

test('ingestion turns fixture mail into bills, filtering non-bills', async () => {
  const provider = createMockEmailProvider();
  const result = await ingestBillsFromEmail(provider, { householdId: 'h1' });

  assert.equal(result.isLive, false, 'the mock must never claim to be live');
  assert.ok(result.billsParsed >= 3);

  const providers = result.billsAccepted.map((b) => b.providerName);
  assert.ok(providers.some((p) => /Power/i.test(p)));
  assert.ok(providers.some((p) => /Water/i.test(p)));

  // Neither the payment confirmation nor the promo may become a bill. They can
  // be filtered at the search stage or by the classifier — what matters is that
  // they never reach the budget, so the assertion is on the outcome rather than
  // on which stage caught them.
  const stored = [...result.billsAccepted, ...result.needsReview];
  assert.ok(!stored.some((b) => b.sourceMessageId === 'msg_confirmation_003'),
    'a payment receipt is not a bill');
  assert.ok(!stored.some((b) => b.sourceMessageId === 'msg_promo_004'),
    'marketing is not a bill');
  assert.ok(result.skipped.some((s) => s.messageId === 'msg_promo_004'));
});

test('the same bill arriving twice is imported once', async () => {
  const result = await ingestBillsFromEmail(createMockEmailProvider(), { householdId: 'h1' });
  const powerBills = [...result.billsAccepted, ...result.needsReview]
    .filter((b) => /Power/i.test(b.providerName));
  assert.equal(powerBills.length, 1, 'the reminder duplicates the statement');
  assert.ok(result.duplicates.length >= 1);
});

test('a disconnected provider reports an error rather than inventing data', async () => {
  const provider = createMockEmailProvider({ connected: false });
  const result = await ingestBillsFromEmail(provider, { householdId: 'h1' });
  assert.equal(result.billsAccepted.length, 0);
  assert.equal(result.errors[0].stage, 'connect');
});

test('low-confidence bills are separated for review, not silently trusted', async () => {
  const result = await ingestBillsFromEmail(createMockEmailProvider(), { householdId: 'h1' });
  for (const b of result.needsReview) assert.ok(needsReview(b));
  for (const b of result.billsAccepted) assert.ok(!needsReview(b));
});

test('ingested bills pass domain validation', async () => {
  const result = await ingestBillsFromEmail(createMockEmailProvider(), { householdId: 'h1' });
  for (const b of [...result.billsAccepted, ...result.needsReview]) {
    const { valid, errors } = validateBill(b);
    assert.ok(valid, `${b.providerName}: ${errors.join(', ')}`);
  }
});

// ---------------------------------------------------------------------------
// PDF attachment fallback — "your e-bill is attached" with almost nothing in
// the body, the exact pattern the body-only parser structurally cannot catch.
// ---------------------------------------------------------------------------

function providerWithAttachment({ bodyText, attachmentBytes = new Uint8Array([1]) }) {
  const message = {
    id: 'msg_pdf_1', from: 'billing@examplepower.com', fromName: 'Example Power',
    subject: 'Your e-bill is ready', receivedAt: '2026-07-18T00:00:00Z',
    bodyText, attachments: [{ id: 'att_1', filename: 'statement.pdf', mimeType: 'application/pdf' }],
  };
  return {
    info: { key: 'test-provider', displayName: 'Test', kind: 'email', isLive: true },
    async isConnected() { return true; },
    async searchMessages() { return [message]; },
    async getMessage(id) { return id === message.id ? message : null; },
    async getAttachment() { return attachmentBytes; },
  };
}

function fakePdfParser(fields) {
  return {
    key: 'pdf',
    canParse: (input) => input.kind === 'pdf',
    async parse() { return { fields, confidence: fields.confidence, warnings: [] }; },
  };
}

test('a PDF attachment fills in what a thin body could not', async () => {
  const provider = providerWithAttachment({ bodyText: 'Your e-bill is attached. Thanks for being a customer.' });
  const pdfParser = fakePdfParser({ amountDue: 203.17, dueDate: '2026-08-08', confidence: 0.95, warnings: [] });

  const result = await ingestBillsFromEmail(provider, { householdId: 'h1', pdfParser });

  assert.equal(result.billsAccepted.length, 1);
  const bill = result.billsAccepted[0];
  assert.equal(bill.amountDue, 203.17);
  assert.equal(bill.dueDate, '2026-08-08');
  assert.equal(bill.source, 'pdf', 'a bill resolved via the attachment is sourced as pdf, not email');
  assert.equal(bill.sourceDocumentId, 'att_1');
});

test('a message with no PDF attachment is unaffected by pdfParser being present', async () => {
  const provider = createMockEmailProvider();
  const pdfParser = fakePdfParser({ amountDue: 999, dueDate: '2026-01-01', confidence: 1, warnings: [] });
  const result = await ingestBillsFromEmail(provider, { householdId: 'h1', pdfParser });
  assert.ok(!result.billsAccepted.some((b) => b.amountDue === 999), 'pdfParser must never be consulted without an attachment');
});

test('a body that already parses fully is not overridden by the PDF fallback', async () => {
  const provider = providerWithAttachment({
    bodyText: 'Total Amount Due $50.00\nDue Date: 08/01/2026',
  });
  const pdfParser = fakePdfParser({ amountDue: 999, dueDate: '2026-01-01', confidence: 1, warnings: [] });
  const result = await ingestBillsFromEmail(provider, { householdId: 'h1', pdfParser });
  assert.equal(result.billsAccepted[0].amountDue, 50, 'the fallback only runs when the body parse is incomplete');
  assert.equal(result.billsAccepted[0].source, 'email');
});

test('a PDF that also fails to parse leaves the message skipped, not accepted with garbage', async () => {
  const provider = providerWithAttachment({ bodyText: 'Your e-bill is attached.' });
  const pdfParser = fakePdfParser({ amountDue: undefined, dueDate: undefined, confidence: 0, warnings: ['empty'] });
  const result = await ingestBillsFromEmail(provider, { householdId: 'h1', pdfParser });
  assert.equal(result.billsAccepted.length, 0);
  assert.equal(result.needsReview.length, 0);
  assert.ok(result.skipped.some((s) => s.messageId === 'msg_pdf_1'));
});

test('a getAttachment failure is recorded as an error but does not abort the whole sync', async () => {
  const provider = providerWithAttachment({ bodyText: 'Your e-bill is attached.' });
  provider.getAttachment = async () => { throw new Error('network blip'); };
  const pdfParser = fakePdfParser({ amountDue: 1, dueDate: '2026-01-01', confidence: 1, warnings: [] });

  const result = await ingestBillsFromEmail(provider, { householdId: 'h1', pdfParser });
  assert.ok(result.errors.some((e) => e.stage === 'pdf' && /network blip/.test(e.message)));
});

test('no pdfParser option means an attachment is simply never looked at', async () => {
  const provider = providerWithAttachment({ bodyText: 'Your e-bill is attached.' });
  const result = await ingestBillsFromEmail(provider, { householdId: 'h1' });
  assert.equal(result.billsAccepted.length, 0);
  assert.equal(result.errors.length, 0, 'no pdfParser means no attempt, not a failed attempt');
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('an adapter missing a contract method is rejected at registration', () => {
  const registry = createRegistry();
  assert.throws(
    () => registry.register({ info: { key: 'broken', displayName: 'Broken', kind: 'bills', isLive: false } }),
    /must implement getBills/,
  );
});

test('an adapter that does not declare liveness is rejected', () => {
  const registry = createRegistry();
  assert.throws(
    () => registry.register({
      info: { key: 'x', displayName: 'X', kind: 'email' },
      isConnected: async () => true, searchMessages: async () => [], getMessage: async () => null,
    }),
    /isLive must be an explicit boolean/,
  );
});

test('mock providers never count as live connections', async () => {
  const registry = createRegistry();
  registry.register(createMockEmailProvider());
  registry.register(createMockPayrollProvider());

  assert.equal(registry.list().length, 2);
  assert.equal((await registry.liveConnected('email')).length, 0);
  assert.equal(registry.hasLiveProvider('email'), false);

  const status = await registry.status();
  assert.ok(status.every((s) => s.isLive === false));
  assert.ok(status.every((s) => s.connected === true), 'connected but not live is the honest state');
});

// ---------------------------------------------------------------------------
// Sync engine
// ---------------------------------------------------------------------------

test('a bill sync records what happened', async () => {
  const store = createMemoryStore();
  const run = await syncBills({
    provider: createMockEmailProvider(),
    store,
    householdId: 'h1',
    emailIngester: ingestBillsFromEmail,
  });

  assert.equal(run.status, 'success');
  assert.equal(run.providerIsLive, false);
  assert.ok(run.itemsCreated > 0);
  assert.ok(run.duplicatesDetected >= 1);
  assert.ok(run.completedAt);
  assert.ok(run.durationMs >= 0);
});

test('re-running a bill sync creates nothing new', async () => {
  const store = createMemoryStore();
  const options = {
    provider: createMockEmailProvider(), store, householdId: 'h1', emailIngester: ingestBillsFromEmail,
  };
  const first = await syncBills(options);
  const second = await syncBills(options);

  assert.ok(first.itemsCreated > 0);
  assert.equal(second.itemsCreated, 0, 'a second sync must not duplicate every bill');
  assert.ok(second.duplicatesDetected > 0);
});

test('a disconnected provider yields a skipped run, not a failure', async () => {
  const run = await syncBills({
    provider: createMockEmailProvider({ connected: false }),
    store: createMemoryStore(),
    householdId: 'h1',
    emailIngester: ingestBillsFromEmail,
  });
  assert.equal(run.status, 'skipped');
  assert.equal(run.itemsCreated, 0);
});

test('re-importing a timecard corrects days rather than duplicating them', async () => {
  const store = createMemoryStore();
  const options = {
    provider: createMockPayrollProvider({ householdId: 'h1' }),
    store,
    householdId: 'h1',
    period: { start: '2026-07-20', end: '2026-08-02' },
  };
  const first = await syncPayroll(options);
  const second = await syncPayroll(options);

  assert.ok(first.itemsCreated > 0);
  assert.equal(second.itemsCreated, 0);
  assert.equal(second.itemsUpdated, first.itemsCreated);
  assert.equal(store.timeEntries.length, first.itemsCreated);
});

test('paystub sync dedupes on re-run', async () => {
  const store = createMemoryStore();
  const options = {
    provider: createMockPayrollProvider({ householdId: 'h1' }), store, householdId: 'h1',
  };
  const first = await syncPaystubs(options);
  const second = await syncPaystubs(options);

  assert.equal(first.itemsCreated, 3);
  assert.equal(second.itemsCreated, 0);
  assert.equal(second.duplicatesDetected, 3);
});

test('sync summary distinguishes live providers from mocks', async () => {
  const store = createMemoryStore();
  await syncBills({
    provider: createMockEmailProvider(), store, householdId: 'h1', emailIngester: ingestBillsFromEmail,
  });

  const summary = summarizeSyncState(store.runs);
  assert.equal(summary.liveProviders, 0);
  assert.equal(summary.mockProviders, 1);
  assert.equal(summary.providers[0].relative, 'just now');
  assert.equal(summary.anyStale, false);
});

test('an old sync is reported stale', () => {
  const old = new Date(Date.now() - 72 * 3600000).toISOString();
  const summary = summarizeSyncState([{
    provider: 'x', kind: 'bills', status: 'success', providerIsLive: true,
    startedAt: old, completedAt: old, itemsCreated: 0, errors: [],
  }]);
  assert.equal(summary.anyStale, true);
  assert.match(summary.providers[0].relative, /days ago/);
});

// ---------------------------------------------------------------------------
// Safe to spend
// ---------------------------------------------------------------------------

const spendInput = {
  currentBalance: 2400,
  asOf: '2026-08-05',
  nextPayday: '2026-08-19',
  dailyVariableSpend: 35,
  bills: [
    makeBill({ householdId: 'h1', providerName: 'Power', amountDue: 203.17, dueDate: '2026-08-08', category: 'Utilities', source: 'email', confidence: 0.9 }),
    makeBill({ householdId: 'h1', providerName: 'Water', amountDue: 74.2, dueDate: '2026-08-12', category: 'Utilities', source: 'email', confidence: 0.9 }),
    // After payday — must not be deducted from this stretch.
    makeBill({ householdId: 'h1', providerName: 'Insurance', amountDue: 1428, dueDate: '2026-09-01', category: 'Insurance', source: 'email', confidence: 0.9 }),
  ],
};

test('safe to spend is not simply balance minus bills', () => {
  const result = calculateSafeToSpend(spendInput);
  const naive = 2400 - 203.17 - 74.2;
  assert.ok(result.safeToSpend < naive, 'ongoing variable spending must be accounted for');
  assert.ok(result.deductions.some((d) => /Groceries/.test(d.label)));
});

test('only bills due before the next payday are counted', () => {
  const result = calculateSafeToSpend(spendInput);
  assert.equal(result.inputs.billsCounted, 2, 'the September premium is not in this stretch');
});

test('pending transactions reduce what is available', () => {
  const without = calculateSafeToSpend(spendInput);
  const with_ = calculateSafeToSpend({ ...spendInput, pendingOutflows: 180 });
  assert.equal(round(without.safeToSpend - with_.safeToSpend), 180);
});

test('the emergency buffer is held back, not spendable', () => {
  const result = calculateSafeToSpend({ ...spendInput, bufferTarget: 1000, bufferBalance: 250 });
  const buffer = result.deductions.find((d) => /buffer/i.test(d.label));
  assert.equal(buffer.amount, 750, 'only the shortfall against the target is withheld');
});

test('savings goals and sinking funds are prorated across the stretch', () => {
  const result = calculateSafeToSpend({
    ...spendInput,
    sinkingFundContribution: 480,
    savingsGoals: [{ label: 'Baby fund', monthlyContribution: 300 }],
  });
  const sinking = result.deductions.find((d) => /annual bills/i.test(d.label));
  const goal = result.deductions.find((d) => /Baby fund/.test(d.label));
  // 14 days of a monthly figure, not the whole month.
  assert.ok(sinking.amount > 0 && sinking.amount < 480);
  assert.ok(goal.amount > 0 && goal.amount < 300);
});

test('a negative result says so plainly', () => {
  const result = calculateSafeToSpend({ ...spendInput, currentBalance: 200 });
  assert.equal(result.status, 'negative');
  assert.ok(result.safeToSpend < 0);
  assert.match(result.headline, /exceeds available money/);
});

test('every deduction is explained', () => {
  const result = calculateSafeToSpend({ ...spendInput, pendingOutflows: 50, bufferTarget: 500 });
  for (const d of result.deductions) {
    assert.ok(d.label && d.note, 'an unexplained number gets ignored by users');
    assert.ok(typeof d.amount === 'number');
  }
});

test('low-confidence bills are counted but flagged', () => {
  const result = calculateSafeToSpend({
    ...spendInput,
    bills: [makeBill({
      householdId: 'h1', providerName: 'Guess', amountDue: 500, dueDate: '2026-08-10',
      source: 'email', confidence: 0.4,
    })],
  });
  assert.ok(result.warnings.some((w) => /low confidence/.test(w)));
  assert.equal(result.inputs.billsCounted, 1, 'excluding it would overstate available money');
});

test('the monthly overview separates paid from upcoming', () => {
  const overview = monthlyOverview({
    month: '2026-08',
    expectedIncome: 6420,
    asOf: '2026-08-05',
    nextPayday: '2026-08-19',
    bills: [
      makeBill({ householdId: 'h1', providerName: 'Rent', amountDue: 1105, dueDate: '2026-08-01', status: 'paid', paidAmount: 1105 }),
      makeBill({ householdId: 'h1', providerName: 'Power', amountDue: 203.17, dueDate: '2026-08-08' }),
      makeBill({ householdId: 'h1', providerName: 'Water', amountDue: 74.2, dueDate: '2026-08-12' }),
      makeBill({ householdId: 'h1', providerName: 'Card', amountDue: 459.63, dueDate: '2026-08-25' }),
    ],
  });

  assert.equal(overview.alreadyPaid, 1105);
  assert.equal(overview.upcoming, 737);
  assert.equal(overview.billsTotal, 1842);
  assert.equal(overview.dueBeforeNextPaycheckCount, 2);
  assert.equal(overview.dueBeforeNextPaycheck, 277.37);
});

test('billsDueBetween excludes paid and ignored bills', () => {
  const bills = [
    makeBill({ householdId: 'h1', providerName: 'A', amountDue: 10, dueDate: '2026-08-08' }),
    makeBill({ householdId: 'h1', providerName: 'B', amountDue: 20, dueDate: '2026-08-09', status: 'paid' }),
    makeBill({ householdId: 'h1', providerName: 'C', amountDue: 30, dueDate: '2026-08-10', status: 'ignored' }),
  ];
  const due = billsDueBetween(bills, '2026-08-01', '2026-08-19');
  assert.equal(due.length, 1);
  assert.equal(due[0].providerName, 'A');
});

function round(n) {
  return Math.round(n * 100) / 100;
}
