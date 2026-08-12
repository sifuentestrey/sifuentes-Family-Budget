/**
 * Bills proposed from the household's own recurring charges.
 *
 * The failure that matters most here is a false positive: offering "Trader
 * Joe's" as a bill teaches the household to ignore the list, and accepting one
 * puts a made-up obligation into safe-to-spend. So most of these tests are
 * about what must NOT be suggested.
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
  // After a price rise the median lags behind what will actually be charged,
  // and a bill is a forecast of the next payment.
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
  assert.equal(suggestions.length, 0, 'an unrecognized category with a varying amount is shopping');
});

test('a set-price charge in an unknown category is offered once it has a track record', () => {
  const twice = suggestBillsFromTransactions({
    streams: [stream({
      payee: 'Bright Storage', category: 'Uncategorized',
      amounts: [89, 89], occurrences: 2, last_amount: 89,
    })],
    asOf,
  });
  assert.equal(twice.length, 0, 'two charges is not yet a track record');

  const thrice = suggestBillsFromTransactions({
    streams: [stream({
      payee: 'Bright Storage', category: 'Uncategorized',
      amounts: [89, 89, 89], occurrences: 3, last_amount: 89,
    })],
    asOf,
  });
  assert.equal(thrice.length, 1);
  assert.equal(thrice[0].category, 'Other', 'an unmappable category falls back rather than inventing one');
});

test('suggestions are ordered by amount, biggest first', () => {
  const suggestions = suggestBillsFromTransactions({
    streams: [
      stream({ payee: 'Streamly', category: 'Subscriptions', last_amount: 15, amounts: [15, 15, 15] }),
      stream({ payee: 'First Mortgage', category: 'Rent/Mortgage', last_amount: 1900, amounts: [1900, 1900, 1900] }),
      stream({ payee: 'City Power', last_amount: 148 }),
    ],
    asOf,
  });

  assert.deepEqual(suggestions.map((s) => s.providerName), ['First Mortgage', 'City Power', 'Streamly']);
});

test('a long-passed expected date is flagged as possibly stopped', () => {
  // A next_expected that came and went weeks ago usually means the charge
  // stopped — worth showing, worth not presenting as a confident upcoming bill.
  const [s] = suggestBillsFromTransactions({ streams: [stream()], asOf: '2026-09-01' });
  assert.equal(s.stale, true);
});

test('normal billing-date drift is not called a stopped charge', () => {
  // Billing dates move a few days routinely — weekends, month lengths, a
  // provider shifting its cycle. Flagging that would put a scary caveat on
  // almost every healthy bill.
  const dueToday = suggestBillsFromTransactions({ streams: [stream()], asOf: '2026-08-03' });
  assert.equal(dueToday[0].stale, false, 'due today is not stopped');

  const threeLate = suggestBillsFromTransactions({ streams: [stream()], asOf: '2026-08-06' });
  assert.equal(threeLate[0].stale, false, 'three days late is ordinary drift');
});

test('an expected date already passed rolls forward instead of creating an overdue bill', () => {
  // Saving a past date makes a bill that is overdue the instant it exists —
  // it lands in red on Home and in "due before your next check", for a charge
  // nobody is actually behind on.
  const [s] = suggestBillsFromTransactions({ streams: [stream()], asOf: '2026-08-20' });
  assert.ok(s.dueDate >= '2026-08-20', `rolled to ${s.dueDate}, which is still in the past`);
  assert.equal(s.dueDate, '2026-09-02', 'one monthly cycle past the projected 2026-08-03');
});

test('a still-future expected date is left exactly as projected', () => {
  const [s] = suggestBillsFromTransactions({ streams: [stream()], asOf: '2026-07-20' });
  assert.equal(s.dueDate, '2026-08-03');
});

test('every billable cadence is one the detector can actually produce', () => {
  // A cadence listed here that inferCadence never returns matches nothing and
  // fails silently — the filter just quietly drops those streams forever.
  const producible = new Set(['weekly', 'biweekly', 'semimonthly', 'monthly']);
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

  // Every mapping must land somewhere the Add-a-bill dropdown can display,
  // or a suggestion pre-fills a category that silently saves as something else.
  for (const name of SEED_CATEGORIES.map(([, label]) => label)) {
    assert.ok(
      BILL_CATEGORIES.includes(toBillCategory(name)),
      `"${name}" maps to "${toBillCategory(name)}", which is not a bill category`,
    );
  }
});

test('the obligation categories are real categorizer labels', () => {
  // A misspelt or invented label here fails silently — the category test just
  // never matches and real bills quietly stop being offered.
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
