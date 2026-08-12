/**
 * The monthly budget — bills plus necessities.
 *
 * The failures worth guarding are double-counting (a bill also showing as a
 * category line) and confident-looking defaults built from too little history.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMonthlyBudget, typicalMonthly, spendingOnly, MIN_MONTHS_FOR_TARGET, NOT_NECESSITIES,
} from '../src/engine/budget/monthly-budget.js';

let seq = 0;
const txn = (over = {}) => ({
  plaid_transaction_id: `t${seq += 1}`,
  posted_date: '2026-08-04',
  payee: 'Store',
  amount: 50,
  category: 'Groceries',
  is_transfer: false,
  is_income: false,
  pending: false,
  ...over,
});

const bill = (over = {}) => ({
  id: 'b1',
  providerName: 'City Power',
  category: 'Utilities',
  dueDate: '2026-08-15',
  amountDue: 142,
  status: 'scheduled',
  ...over,
});

test('spendingOnly drops transfers, income, pending and the parent of a split', () => {
  // A split keeps its pieces and drops the original, so the same charge is
  // counted once at its categorized parts rather than twice.
  const parent = txn({ plaid_transaction_id: 'p1' });
  const rows = [
    parent,
    txn({ plaid_transaction_id: 'c1', parent_transaction_id: 'p1' }),
    txn({ is_transfer: true }),
    txn({ is_income: true }),
    txn({ pending: true }),
    txn({ amount: -30 }), // refund
  ];
  const kept = spendingOnly(rows);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].plaid_transaction_id, 'c1');
});

test('necessity lines cover groceries and gas, not dining out', () => {
  const budget = buildMonthlyBudget({
    month: '2026-08',
    transactions: [
      txn({ category: 'Groceries', amount: 220 }),
      txn({ category: 'Gas', amount: 60 }),
      txn({ category: 'Dining Out', amount: 95 }),
    ],
  });

  const cats = budget.necessities.map((l) => l.category);
  assert.ok(cats.includes('Groceries'));
  assert.ok(cats.includes('Gas'));
  assert.ok(!cats.includes('Dining Out'), 'dining out is not a necessity');
  assert.equal(budget.totals.otherSpent, 95);
});

test('a gym membership is not a necessity just because it charges the same every month', () => {
  const budget = buildMonthlyBudget({
    month: '2026-08',
    transactions: [
      txn({ category: 'Fitness', amount: 49 }),
      txn({ category: 'Subscriptions', amount: 41 }),
      txn({ category: 'Savings', amount: 300 }),
      txn({ category: 'Groceries', amount: 200 }),
    ],
  });
  assert.deepEqual(budget.necessities.map((l) => l.category), ['Groceries']);
  assert.ok(NOT_NECESSITIES.has('Fitness'));
});

test('a category a tracked bill covers is not repeated as a necessity line', () => {
  const budget = buildMonthlyBudget({
    month: '2026-08',
    bills: [bill()],
    transactions: [
      txn({ category: 'Utilities', amount: 142, payee: 'City Power' }),
      txn({ category: 'Groceries', amount: 200 }),
    ],
  });

  assert.deepEqual(budget.necessities.map((l) => l.category), ['Groceries']);
  assert.equal(budget.totals.billsPlanned, 142);
  // 142 counted once, via the bill.
  assert.equal(budget.totals.planned, 142 + budget.totals.necessitiesPlanned);
});

test('bills outside the month and ignored bills are left out', () => {
  const budget = buildMonthlyBudget({
    month: '2026-08',
    bills: [
      bill(),
      bill({ id: 'b2', dueDate: '2026-09-15' }),
      bill({ id: 'b3', providerName: 'Old', status: 'ignored' }),
    ],
    transactions: [],
  });
  assert.deepEqual(budget.bills.map((b) => b.id), ['b1']);
});

test('a paid bill still counts as planned but not as remaining', () => {
  const budget = buildMonthlyBudget({
    month: '2026-08',
    bills: [bill({ status: 'paid' })],
    transactions: [],
  });
  assert.equal(budget.totals.billsPlanned, 142);
  assert.equal(budget.totals.billsPaid, 142);
  assert.equal(budget.totals.billsRemaining, 0);
  assert.equal(budget.totals.remaining, 0);
});

test('one prior month is not enough history for a default target', () => {
  const transactions = [
    txn({ posted_date: '2026-07-04', category: 'Groceries', amount: 400 }),
    txn({ posted_date: '2026-08-04', category: 'Groceries', amount: 120 }),
  ];
  assert.equal(MIN_MONTHS_FOR_TARGET, 2);
  assert.equal(typicalMonthly(transactions, 'Groceries', '2026-08'), null);

  const line = buildMonthlyBudget({ month: '2026-08', transactions })
    .necessities.find((l) => l.category === 'Groceries');
  assert.equal(line.planned, null, 'no target invented from a single month');
  assert.equal(line.spent, 120);
  assert.equal(line.remaining, null);
});

test('the default target is the trailing average, rounded to something a person would pick', () => {
  const transactions = [
    txn({ posted_date: '2026-06-04', category: 'Groceries', amount: 487.33 }),
    txn({ posted_date: '2026-07-04', category: 'Groceries', amount: 512.11 }),
    txn({ posted_date: '2026-08-04', category: 'Groceries', amount: 120 }),
  ];
  const line = buildMonthlyBudget({ month: '2026-08', transactions })
    .necessities.find((l) => l.category === 'Groceries');

  assert.equal(line.typical, 499.72);
  assert.equal(line.planned, 500);
  assert.equal(line.plannedSource, 'typical');
  assert.equal(line.remaining, 380);
  assert.equal(line.over, false);
});

test('a target the household set wins over the trailing average', () => {
  const transactions = [
    txn({ posted_date: '2026-06-04', category: 'Groceries', amount: 500 }),
    txn({ posted_date: '2026-07-04', category: 'Groceries', amount: 500 }),
    txn({ posted_date: '2026-08-04', category: 'Groceries', amount: 620 }),
  ];
  const line = buildMonthlyBudget({
    month: '2026-08', transactions, targets: { Groceries: 400 },
  }).necessities.find((l) => l.category === 'Groceries');

  assert.equal(line.planned, 400);
  assert.equal(line.plannedSource, 'set');
  assert.equal(line.remaining, -220);
  assert.equal(line.over, true);
});

test('a set target keeps its line in a month with no spending yet', () => {
  const budget = buildMonthlyBudget({
    month: '2026-08', transactions: [], targets: { Groceries: 450 },
  });
  assert.deepEqual(budget.necessities.map((l) => l.category), ['Groceries']);
  assert.equal(budget.totals.remaining, 450);
});

test('overspending one category does not reduce what the rest of the plan still needs', () => {
  const transactions = [
    txn({ posted_date: '2026-06-04', category: 'Groceries', amount: 500 }),
    txn({ posted_date: '2026-07-04', category: 'Groceries', amount: 500 }),
    txn({ posted_date: '2026-08-04', category: 'Groceries', amount: 900 }),
  ];
  const budget = buildMonthlyBudget({
    month: '2026-08', transactions, targets: { Gas: 200 },
  });
  // Groceries is $400 over; Gas has spent nothing of its $200.
  assert.equal(budget.totals.remaining, 200);
});
