/**
 * Bills proposed from the household's own recurring charges.
 *
 * The failure that matters most here is a false positive: offering Google,
 * Apple or Trader Joe's as a bill teaches the household to ignore the list,
 * and accepting one puts a made-up obligation into the paycheck plan.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeBill, BILL_CATEGORIES } from '../src/domain/bill.js';
import { SEED_CATEGORIES } from '../src/engine/seed-rules.js';
import { projectNext } from '../src/engine/cadence.js';
import {
  suggestBillsFromTransactions,
  isSteadyAmount,
  toBillCategory,
  alreadyTracked,
  streamToBillDraft,
  OBLIGATION_CATEGORIES,
  BILLABLE_CADENCES,
} from '../src/engine/bill-suggestions.js';

const stream = (overrides = {}) => ({
  account_id: 'acct_1',
  payee: 'City Power',
  category: 'Utilities',
  cadence: 'monthly',
  typical_amount: 142,
  last_amount: 148,
  amounts: [140, 142, 148],
  dates: ['2026-05-03', '2026-06-03', '2026-07-03'],
  occurrences: 3,
  last_seen: '2026-07-03',
  next_expected: '2026-08-03',
  confidence: 'high',
  ...overrides,
});

const asOf = '2026-07-20';

test('a recurring utility charge is offered as a bill', () => {
  const [s] = suggestBillsFromTransactions({ streams: [stream()], asOf });

  assert.equal(s.providerName, 'City Power');
  assert.equal(s.category, 'Utilities');
  assert.equal(s.dueDate, '2026-08-03');
  assert.equal(s.occurrences, 3);
  assert.equal(s.stale, false);
});

test('the amount offered is the last charge, not the median', () => {
  const [s] = suggestBillsFromTransactions({ streams: [stream()], asOf });
  assert.equal(s.amountDue, 148);
});

test('a bill already tracked from another source is not offered again', () => {
  const tracked = makeBill({
    householdId: 'h1', providerName: 'CITY POWER CO', amountDue: 140,
    dueDate: '2026-08-03', source: 'email',
  });

  const suggestions = suggestBillsFromTransactions({ streams: [stream()], bills: [tracked], asOf });
  assert.equal(suggestions.length, 0, 'fuzzy provider match must suppress the duplicate');
});

test('a weekly charge is never offered — that is a habit, not a bill', () => {
  const suggestions = suggestBillsFromTransactions({
    streams: [stream({ payee: 'Corner Coffee', category: 'Dining Out', cadence: 'weekly' })],
    asOf,
  });
  assert.equal(suggestions.length, 0);
});

test('a frequently-visited merchant with a varying amount is not offered', () => {
  const suggestions = suggestBillsFromTransactions({
    streams: [stream({
      payee: 'Trader Joes',
      category: 'Groceries',
      amounts: [64, 121, 38, 97],
      occurrences: 4,
      last_amount: 97,
    })],
    asOf,
  });
  assert.equal(suggestions.length, 0, 'shopping is not a bill');
});

test('a steady unknown charge is still not promoted into Bills', () => {
  const suggestions = suggestBillsFromTransactions({
    streams: [stream({
      payee: 'Mystery Service', category: 'Uncategorized',
      amounts: [89, 89, 89, 89], occurrences: 4, last_amount: 89,
    })],
    asOf,
  });
  assert.equal(suggestions.length, 0, 'stable price alone is not evidence of a household obligation');
});

test('subscriptions stay out of Bills even when perfectly recurring', () => {
  const suggestions = suggestBillsFromTransactions({
    streams: [
      stream({ payee: 'Google', category: 'Subscriptions', last_amount: 3.19, amounts: [3.19, 3.19, 3.19] }),
      stream({ payee: 'Apple', category: 'Subscriptions', last_amount: 2.99, amounts: [2.99, 2.99, 2.99] }),
    ],
    asOf,
  });
  assert.deepEqual(suggestions, []);
});

test('suggestions are ordered by amount, biggest first, without subscriptions', () => {
  const suggestions = suggestBillsFromTransactions({
    streams: [
      stream({ payee: 'Google', category: 'Subscriptions', last_amount: 15, amounts: [15, 15, 15] }),
      stream({ payee: 'First Mortgage', category: 'Rent/Mortgage', last_amount: 1900, amounts: [1900, 1900, 1900] }),
      stream({ payee: 'City Power', last_amount: 148 }),
    ],
    asOf,
  });

  assert.deepEqual(suggestions.map((s) => s.providerName), ['First Mortgage', 'City Power']);
});

test('a long-passed expected date is flagged as possibly stopped', () => {
  const [s] = suggestBillsFromTransactions({ streams: [stream()], asOf: '2026-09-01' });
  assert.equal(s.stale, true);
});

test('normal billing-date drift is not called a stopped charge', () => {
  const dueToday = suggestBillsFromTransactions({ streams: [stream()], asOf: '2026-08-03' });
  assert.equal(dueToday[0].stale, false, 'due today is not stopped');

  const threeLate = suggestBillsFromTransactions({ streams: [stream()], asOf: '2026-08-06' });
  assert.equal(threeLate[0].stale, false, 'three days late is ordinary drift');
});

test('an expected date already passed rolls forward by calendar month', () => {
  const [s] = suggestBillsFromTransactions({ streams: [stream()], asOf: '2026-08-20' });
  assert.ok(s.dueDate >= '2026-08-20', `rolled to ${s.dueDate}, which is still in the past`);
  assert.equal(s.dueDate, '2026-09-03', 'monthly projection preserves the day instead of adding 30 days');
});

test('a still-future expected date is left exactly as projected', () => {
  const [s] = suggestBillsFromTransactions({ streams: [stream()], asOf: '2026-07-20' });
  assert.equal(s.dueDate, '2026-08-03');
});

test('quarterly obligations are billable and roll by three calendar months', () => {
  const [s] = suggestBillsFromTransactions({
    streams: [stream({
      payee: 'County HOA', category: 'Taxes', cadence: 'quarterly',
      dates: ['2026-01-01', '2026-04-01', '2026-07-01'],
      amounts: [300, 300, 300], last_amount: 300, typical_amount: 300,
      last_seen: '2026-07-01', next_expected: '2026-10-01',
    })],
    asOf,
  });
  assert.equal(s.providerName, 'County HOA');
  assert.equal(s.cadence, 'quarterly');
  assert.equal(s.dueDate, '2026-10-01');
});

test('every billable cadence is one the detector can produce and project', () => {
  const producible = new Set(['weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly']);
  for (const cadence of BILLABLE_CADENCES) {
    assert.ok(producible.has(cadence), `inferCadence never returns "${cadence}"`);
    assert.ok(
      projectNext('2026-01-15', cadence),
      `projectNext cannot advance "${cadence}", so a passed due date could not roll forward`,
    );
  }
});

test('a varying amount is marked so the household knows to check it', () => {
  const [s] = suggestBillsFromTransactions({
    streams: [stream({ amounts: [90, 142, 210], last_amount: 210 })],
    asOf,
  });
  assert.equal(s.amountVaries, true);
  assert.equal(s.confidence, 'low');
  assert.match(s.reason, /amount varies/);
});

test('isSteadyAmount tolerates small drift but not a real price change', () => {
  assert.equal(isSteadyAmount([100, 105, 102]), true);
  assert.equal(isSteadyAmount([100, 160]), false);
  assert.equal(isSteadyAmount([100]), false, 'one charge is not a pattern');
});

test('bill categories stay inside the list the bill form can actually show', () => {
  assert.equal(toBillCategory('Fitness'), 'Subscriptions');
  assert.equal(toBillCategory('Utilities'), 'Utilities');
  assert.equal(toBillCategory('Something Invented'), 'Other');
  assert.equal(toBillCategory(null), 'Other');

  for (const name of SEED_CATEGORIES.map(([, label]) => label)) {
    assert.ok(
      BILL_CATEGORIES.includes(toBillCategory(name)),
      `"${name}" maps to "${toBillCategory(name)}", which is not a bill category`,
    );
  }
});

test('the obligation categories are real categorizer labels', () => {
  const real = new Set(SEED_CATEGORIES.map(([, label]) => label));
  for (const name of OBLIGATION_CATEGORIES) {
    assert.ok(real.has(name), `"${name}" is not a category the categorizer emits`);
  }
});

test('alreadyTracked matches across spelling differences between channels', () => {
  const s = stream({ payee: 'NETFLIX.COM' });
  assert.equal(alreadyTracked(s, [{ providerName: 'Netflix', providerKey: 'netflix' }]), true);
  assert.equal(alreadyTracked(s, [{ providerName: 'Hulu', providerKey: 'hulu' }]), false);
});

test('the draft carries a provider key so the bill dedupes against future parses', () => {
  const draft = streamToBillDraft(stream({ payee: 'City Power & Light' }));
  assert.equal(draft.providerKey, 'city-power-light');
});
