import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransaction, confirmObligation, discoverObligations, normalizePayee } from '../src/engine/obligations.mjs';

test('normalizes merchant variants', () => {
  assert.equal(normalizePayee('Example Electric, Inc.'), 'example electric');
});

test('excludes transfers and income from obligation discovery', () => {
  const txs = [
    { id: 't1', accountId: 'a', date: '2026-01-01', merchant: 'Paycheck', amount: -2000, isIncome: true },
    { id: 't2', accountId: 'a', date: '2026-01-02', merchant: 'Transfer', amount: 500, isTransfer: true },
    { id: 't3', accountId: 'a', date: '2026-01-05', merchant: 'Electric Co', amount: 120 },
    { id: 't4', accountId: 'a', date: '2026-02-05', merchant: 'Electric Co', amount: 160 },
    { id: 't5', accountId: 'a', date: '2026-03-05', merchant: 'Electric Co', amount: 140 },
  ];
  const results = discoverObligations(txs);
  assert.equal(results.length, 1);
  assert.equal(results[0].normalizedMerchant, 'electric co');
  assert.equal(results[0].frequency, 'monthly');
  assert.equal(results[0].needsReview, true);
});

test('recognizes explicit card payments as debt payments, not spending', () => {
  assert.equal(classifyTransaction({ merchant: 'Chase Credit Card Payment', amount: 900 }), 'debt_payment');
});

test('requires explicit classification before confirming a candidate', () => {
  const candidate = discoverObligations([
    { id: '1', accountId: 'a', date: '2026-01-01', merchant: 'Internet', amount: 80 },
    { id: '2', accountId: 'a', date: '2026-02-01', merchant: 'Internet', amount: 80 },
    { id: '3', accountId: 'a', date: '2026-03-01', merchant: 'Internet', amount: 80 },
  ])[0];
  assert.throws(() => confirmObligation(candidate, {}));
  const confirmed = confirmObligation(candidate, { classification: 'bill', name: 'Internet' });
  assert.equal(confirmed.classification, 'bill');
  assert.equal(confirmed.needsReview, false);
});
