/**
 * Bill <-> Postgres row mapping round trip.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { billToRow, rowToBill } from '../src/ingestion/bill-row-mapping.js';
import { makeBill } from '../src/domain/bill.js';

test('a fully populated bill survives a round trip through row shape', () => {
  const bill = makeBill({
    id: 'bill_1',
    householdId: 'house_1',
    providerName: 'Example Power & Light',
    providerKey: 'example-power-light',
    category: 'Utilities',
    accountLabel: '8842',
    amountDue: 203.17,
    dueDate: '2026-08-08',
    statementDate: '2026-07-17',
    statementPeriod: { start: '2026-06-16', end: '2026-07-15' },
    status: 'detected',
    source: 'email',
    sourceMessageId: 'msg_utility_001',
    confidence: 0.92,
    notes: 'auto-detected',
    raw: { amountLabel: 'Total Amount Due' },
  });

  const row = billToRow(bill);
  assert.equal(row.household_id, 'house_1');
  assert.equal(row.amount_due, 203.17);
  assert.equal(row.due_date, '2026-08-08');
  assert.equal(row.statement_period_start, '2026-06-16');
  assert.equal(row.statement_period_end, '2026-07-15');
  assert.equal(row.source_message_id, 'msg_utility_001');

  const back = rowToBill(row);
  assert.equal(back.householdId, bill.householdId);
  assert.equal(back.providerName, bill.providerName);
  assert.equal(back.providerKey, bill.providerKey);
  assert.equal(back.category, bill.category);
  assert.equal(back.accountLabel, bill.accountLabel);
  assert.equal(back.amountDue, bill.amountDue);
  assert.equal(back.dueDate, bill.dueDate);
  assert.equal(back.statementDate, bill.statementDate);
  assert.deepEqual(back.statementPeriod, bill.statementPeriod);
  assert.equal(back.status, bill.status);
  assert.equal(back.source, bill.source);
  assert.equal(back.sourceMessageId, bill.sourceMessageId);
  assert.equal(back.confidence, bill.confidence);
  assert.equal(back.needsReview, false);
  assert.equal(back.notes, bill.notes);
  assert.deepEqual(back.raw, bill.raw);
});

test('optional fields that are absent map to null in the row, not undefined or omitted', () => {
  const bill = makeBill({
    householdId: 'house_1',
    providerName: 'Example Water',
    amountDue: 74.20,
    dueDate: '2026-08-05',
    source: 'manual',
  });
  const row = billToRow(bill);

  assert.equal(row.account_label, null);
  assert.equal(row.statement_date, null);
  assert.equal(row.statement_period_start, null);
  assert.equal(row.source_message_id, null);
  assert.equal(row.paid_at, null);
  assert.equal(row.paid_amount, null);
});

test('a zero confidence and a zero amount survive the round trip rather than being treated as missing', () => {
  // ?? must be used throughout, not || — a bill genuinely worth $0, or a
  // parse so bad confidence is 0, must not silently become some default.
  const row = billToRow(makeBill({
    householdId: 'h', providerName: 'P', amountDue: 0, dueDate: '2026-08-01',
    source: 'email', confidence: 0,
  }));
  assert.equal(row.amount_due, 0);
  assert.equal(row.confidence, 0);

  const back = rowToBill(row);
  assert.equal(back.amountDue, 0);
  assert.equal(back.confidence, 0);
});

test('rowToBill converts numeric columns even when PostgREST hands them back as strings', () => {
  // numeric columns come back as JSON strings over PostgREST — the exact trap
  // documented in src/payroll/mapping.js for pay rates.
  const row = {
    id: 'bill_2', household_id: 'h', provider_name: 'P', provider_key: 'p',
    category: 'Other', amount_due: '99.99', currency: 'USD', due_date: '2026-08-14',
    status: 'detected', source: 'email', confidence: '0.850', needs_review: false,
    detected_at: '2026-07-25T07:15:00Z', paid_amount: '99.99',
  };
  const bill = rowToBill(row);
  assert.equal(bill.amountDue, 99.99);
  assert.strictEqual(typeof bill.amountDue, 'number');
  assert.equal(bill.confidence, 0.85);
  assert.strictEqual(typeof bill.confidence, 'number');
  assert.equal(bill.paidAmount, 99.99);
  assert.strictEqual(typeof bill.paidAmount, 'number');
});

test('needsReview round-trips both ways: on for the review queue, off for accepted bills', () => {
  const flagged = billToRow({ ...makeBill({ householdId: 'h', providerName: 'P', amountDue: 10, dueDate: '2026-08-01', source: 'email' }), needsReview: true });
  assert.equal(flagged.needs_review, true);
  assert.equal(rowToBill(flagged).needsReview, true);

  const accepted = billToRow(makeBill({ householdId: 'h', providerName: 'P', amountDue: 10, dueDate: '2026-08-01', source: 'email' }));
  assert.equal(accepted.needs_review, false);
});

test('a statementPeriod with only a start date still round-trips the end as null, not crashing', () => {
  const bill = makeBill({
    householdId: 'h', providerName: 'P', amountDue: 10, dueDate: '2026-08-01', source: 'email',
    statementPeriod: { start: '2026-07-01' },
  });
  const row = billToRow(bill);
  assert.equal(row.statement_period_start, '2026-07-01');
  // null, not undefined: the row is headed for an insert/update where the
  // column must be explicitly cleared, not silently left out of the payload.
  assert.equal(row.statement_period_end, null);

  const back = rowToBill(row);
  assert.equal(back.statementPeriod.start, '2026-07-01');
});
