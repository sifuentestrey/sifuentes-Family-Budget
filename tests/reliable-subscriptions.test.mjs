import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReliableSubscriptionStreams } from '../src/engine/reliable-subscriptions.js';

const txn = (date, payee, amount, category, raw = payee) => ({
  account_id: 'checking',
  posted_date: date,
  payee,
  amount,
  category,
  raw_description: raw,
  pending: false,
  is_transfer: false,
  is_income: false,
});

test('Groupon shopping burst is not promoted to a recurring obligation', () => {
  const streams = buildReliableSubscriptionStreams([
    txn('2026-07-30', 'Groupon', 41.59, 'Entertainment'),
    txn('2026-07-31', 'Groupon', 10.61, 'Entertainment'),
    txn('2026-08-10', 'Groupon', 174.69, 'Entertainment'),
  ]);
  assert.deepEqual(streams, []);
});

test('Microsoft and Microsoft Xbox aliases become one monthly Xbox subscription', () => {
  const streams = buildReliableSubscriptionStreams([
    txn('2026-06-12', 'Microsoft', 10.65, 'Subscriptions', 'MICROSOFT REDMOND RECURRING'),
    txn('2026-06-25', 'Microsoft Xbox', 24.35, 'Entertainment', 'MICROSOFT*XBOX MSBILL.INFO'),
    txn('2026-07-06', 'Microsoft Xbox', 9.73, 'Entertainment', 'MICROSOFT*XBOX MSBILL.INFO'),
    txn('2026-07-13', 'Microsoft Xbox', 10.65, 'Subscriptions', 'Microsoft*Xbox RECURRING'),
    txn('2026-08-12', 'Microsoft', 10.65, 'Shopping', 'MICROSOFT REDMOND RECURRING'),
  ]);

  assert.equal(streams.length, 1);
  assert.equal(streams[0].payee, 'Microsoft Xbox');
  assert.equal(streams[0].cadence, 'monthly');
  assert.equal(streams[0].last_amount, 10.65);
  assert.equal(streams[0].next_expected, '2026-09-12');
  assert.deepEqual(streams[0].dates, ['2026-06-12', '2026-07-13', '2026-08-12']);
});

test('two explicitly recurring monthly charges are enough to show a new subscription', () => {
  const streams = buildReliableSubscriptionStreams([
    txn('2026-07-15', 'Google', 3.19, 'Subscriptions', 'GOOGLE RECURRING'),
    txn('2026-08-15', 'Google', 3.19, 'Subscriptions', 'GOOGLE RECURRING'),
  ]);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].cadence, 'monthly');
  assert.equal(streams[0].confidence, 'low');
});

test('stable same-price entertainment can qualify after three regular occurrences', () => {
  const streams = buildReliableSubscriptionStreams([
    txn('2026-06-01', 'Game Service', 14.99, 'Entertainment'),
    txn('2026-07-01', 'Game Service', 14.99, 'Entertainment'),
    txn('2026-08-01', 'Game Service', 14.99, 'Entertainment'),
  ]);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].cadence, 'monthly');
});
