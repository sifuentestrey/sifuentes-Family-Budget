import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDinnerGuidance, parseFinanceAdvisorIntent } from '../src/engine/finance-advisor.js';

test('turns a false subscription correction into one reviewable merchant action', () => {
  assert.deepEqual(
    parseFinanceAdvisorIntent("Film Alley isn't a subscription, just a movie theater we frequent"),
    { type: 'merchant_rule', merchant: 'Film Alley', category: 'Entertainment', suppressRecurring: true },
  );
});

test('understands a household grocery rule', () => {
  assert.deepEqual(
    parseFinanceAdvisorIntent('Add a rule that Walmart adds towards grocery budget'),
    { type: 'merchant_rule', merchant: 'Walmart', category: 'Groceries', suppressRecurring: false },
  );
});

test('dinner amount never exceeds either the category allowance or checking after bills', () => {
  const result = buildDinnerGuidance({
    asOf: '2026-08-23',
    transactions: [
      { payee: 'Local Grill', posted_date: '2026-08-18', amount: 42, category: 'Dining Out' },
      { payee: 'Local Grill', posted_date: '2026-08-01', amount: 38, category: 'Dining Out' },
      { payee: 'Refund', posted_date: '2026-08-04', amount: -30, category: 'Dining Out' },
      { payee: 'Transfer', posted_date: '2026-08-04', amount: 20, category: 'Dining Out', is_transfer: true },
    ],
    plan: {
      allowances: [{ category: 'Dining Out', left: 75 }],
      facts: {
        checking: { available: 140 },
        dueBeforeNextPayday: { total: 90, bills: [{ amountSource: 'verified amount' }] },
      },
      forecasts: { nextPaycheck: { date: '2026-08-28' } },
      diagnostics: { checkingBalanceIsAvailable: true },
    },
  });

  assert.equal(result.amount, 50);
  assert.equal(result.confidence, 'high');
  assert.equal(result.recommendation.merchant, 'Local Grill');
  assert.equal(result.recommendation.typical, 40);
});

test('does not manufacture a dinner allowance without an agreed target', () => {
  const result = buildDinnerGuidance({
    asOf: '2026-08-23',
    plan: {
      allowances: [],
      facts: { checking: { available: 1000 }, dueBeforeNextPayday: { total: 0, bills: [] } },
      forecasts: {}, diagnostics: {},
    },
  });
  assert.equal(result.status, 'needs_target');
  assert.equal(result.amount, null);
});

test('explains the specific bill gap instead of showing an unexplained negative number', () => {
  const result = buildDinnerGuidance({
    asOf: '2026-08-23',
    plan: {
      allowances: [{ category: 'Dining Out', left: 80 }],
      facts: {
        checking: { available: 50 },
        dueBeforeNextPayday: { total: 125, bills: [{ amountSource: 'recurring estimate' }] },
      },
      forecasts: { nextPaycheck: { date: '2026-08-28' } },
      diagnostics: { checkingBalanceIsAvailable: true },
    },
  });
  assert.equal(result.status, 'gap');
  assert.equal(result.amount, 0);
  assert.match(result.explanation, /\$75\.00 is needed/);
});
