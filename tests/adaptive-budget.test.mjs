import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdaptiveBudget } from '../src/engine/adaptive-budget.js';

const txn = (posted_date, category, amount) => ({
  id: `${posted_date}-${category}-${amount}`,
  posted_date,
  category,
  amount,
  pending: false,
  is_transfer: false,
  is_income: false,
  parent_transaction_id: null,
});

test('variable utilities use an upper recent range instead of one rigid average', () => {
  const budget = buildAdaptiveBudget({
    month: '2026-08',
    transactions: [
      txn('2026-05-04', 'Utilities', 310),
      txn('2026-06-04', 'Utilities', 390),
      txn('2026-07-04', 'Utilities', 470),
      txn('2026-08-04', 'Utilities', 428),
    ],
  });

  const utilities = budget.rows.find((row) => row.category === 'Utilities');
  assert.equal(utilities.variable, true);
  assert.equal(utilities.source, 'adaptive');
  assert.equal(utilities.spent, 428);
  assert.ok(utilities.typicalLow < utilities.typicalHigh);
  assert.ok(utilities.planned >= 390);
});

test('a household-set target always wins over the adaptive suggestion', () => {
  const budget = buildAdaptiveBudget({
    month: '2026-08',
    targets: { Groceries: 900 },
    transactions: [
      txn('2026-05-10', 'Groceries', 700),
      txn('2026-06-10', 'Groceries', 760),
      txn('2026-07-10', 'Groceries', 810),
      txn('2026-08-10', 'Groceries', 300),
    ],
  });

  const groceries = budget.rows.find((row) => row.category === 'Groceries');
  assert.equal(groceries.source, 'set');
  assert.equal(groceries.planned, 900);
  assert.equal(groceries.remaining, 600);
});

test('split parents are not counted twice', () => {
  const parent = {
    id: 'parent', posted_date: '2026-08-12', category: 'Shopping', amount: 100,
    pending: false, is_transfer: false, is_income: false, parent_transaction_id: null,
  };
  const childA = {
    id: 'a', posted_date: '2026-08-12', category: 'Groceries', amount: 70,
    pending: false, is_transfer: false, is_income: false, parent_transaction_id: 'parent',
  };
  const childB = {
    id: 'b', posted_date: '2026-08-12', category: 'Shopping', amount: 30,
    pending: false, is_transfer: false, is_income: false, parent_transaction_id: 'parent',
  };

  const budget = buildAdaptiveBudget({ month: '2026-08', transactions: [parent, childA, childB] });
  assert.equal(budget.rows.find((row) => row.category === 'Groceries')?.spent, 70);
  assert.equal(budget.rows.find((row) => row.category === 'Shopping')?.spent, 30);
  assert.equal(budget.totals.spent, 100);
});
