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

test('Apple products at different prices do not turn one monthly service into semi-monthly', () => {
  const streams = buildReliableSubscriptionStreams([
    txn('2026-05-26', 'Apple', 21.65, 'Subscriptions', 'APPLE.COM/BILL RECURRING'),
    txn('2026-06-10', 'Apple', 2.99, 'Subscriptions', 'APPLE.COM/BILL RECURRING'),
    txn('2026-06-18', 'Apple', 21.65, 'Subscriptions', 'APPLE.COM/BILL RECURRING'),
    txn('2026-07-10', 'Apple', 2.99, 'Subscriptions', 'APPLE.COM/BILL RECURRING'),
    txn('2026-07-27', 'Apple', 81.64, 'Subscriptions', 'APPLE.COM/BILL RECURRING'),
    txn('2026-08-10', 'Apple', 2.99, 'Subscriptions', 'APPLE.COM/BILL RECURRING'),
  ], { asOf: '2026-08-14' });

  assert.equal(streams.length, 1);
  assert.equal(streams[0].payee, 'Apple');
  assert.equal(streams[0].cadence, 'monthly');
  assert.equal(streams[0].last_amount, 2.99);
  assert.deepEqual(streams[0].dates, ['2026-06-10', '2026-07-10', '2026-08-10']);
  assert.equal(streams[0].next_expected, '2026-09-10');
});

test('same-day Google charges count as one billing date, not a semi-monthly cadence', () => {
  const streams = buildReliableSubscriptionStreams([
    txn('2026-04-23', 'Google', 3.19, 'Subscriptions', 'GOOGLE RECURRING'),
    txn('2026-05-26', 'Google', 3.19, 'Subscriptions', 'GOOGLE RECURRING'),
    txn('2026-05-26', 'Google', 3.19, 'Subscriptions', 'GOOGLE RECURRING'),
    txn('2026-06-25', 'Google', 3.19, 'Subscriptions', 'GOOGLE RECURRING'),
  ], { asOf: '2026-07-10' });

  assert.equal(streams.length, 1);
  assert.equal(streams[0].cadence, 'monthly');
  assert.deepEqual(streams[0].dates, ['2026-04-23', '2026-05-26', '2026-06-25']);
  assert.equal(streams[0].last_amount, 3.19);
});

test('a missed monthly subscription stops being forecast as a must-pay obligation after grace', () => {
  const streams = buildReliableSubscriptionStreams([
    txn('2026-03-23', 'Spotify', 14.06, 'Subscriptions', 'SPOTIFY RECURRING'),
    txn('2026-04-22', 'Spotify', 14.06, 'Subscriptions', 'SPOTIFY RECURRING'),
    txn('2026-05-22', 'Spotify', 14.06, 'Subscriptions', 'SPOTIFY RECURRING'),
    txn('2026-06-22', 'Spotify', 14.06, 'Subscriptions', 'SPOTIFY RECURRING'),
  ], { asOf: '2026-08-14' });

  assert.deepEqual(streams, []);
});

test('current price cluster wins after a subscription price change', () => {
  const streams = buildReliableSubscriptionStreams([
    txn('2025-11-22', 'Music Service', 12.98, 'Subscriptions', 'MUSIC RECURRING'),
    txn('2025-12-22', 'Music Service', 12.98, 'Subscriptions', 'MUSIC RECURRING'),
    txn('2026-01-22', 'Music Service', 12.98, 'Subscriptions', 'MUSIC RECURRING'),
    txn('2026-02-23', 'Music Service', 14.06, 'Subscriptions', 'MUSIC RECURRING'),
    txn('2026-03-23', 'Music Service', 14.06, 'Subscriptions', 'MUSIC RECURRING'),
    txn('2026-04-22', 'Music Service', 14.06, 'Subscriptions', 'MUSIC RECURRING'),
  ]);

  assert.equal(streams.length, 1);
  assert.equal(streams[0].last_amount, 14.06);
  assert.equal(streams[0].cadence, 'monthly');
});
