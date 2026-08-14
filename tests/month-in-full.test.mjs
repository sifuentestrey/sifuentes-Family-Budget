/**
 * The month split into bills and everything after them.
 *
 * The failure that matters is a dollar landing on both sides, or on neither:
 * the two halves must always add back up to the month's total spending, or
 * the screen is lying about where the money went.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMonthInFull, isBillCategory } from '../src/engine/month-in-full.js';

let seq = 0;
const txn = (over = {}) => ({
  plaid_transaction_id: `t${seq += 1}`,
  posted_date: '2026-08-12',
  payee: 'Store',
  amount: 40,
  category: 'Dining Out',
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

test('the two halves always add back up to the month', () => {
  const m = buildMonthInFull({
    month: '2026-08',
    transactions: [
      txn({ category: 'Rent/Mortgage', amount: 2350 }),
      txn({ category: 'Groceries', amount: 220 }),
      txn({ category: 'Dining Out', amount: 95 }),
      txn({ category: 'Utilities', amount: 187.62 }),
    ],
  });

  assert.equal(m.total, 2852.62);
  assert.equal(round(m.bills.total + m.rest.total), m.total);
  assert.equal(m.bills.total, 2537.62, 'rent and power are bills');
  assert.equal(m.rest.total, 315, 'groceries and dining out are not');
});

test('a charge that paid a tracked bill counts once, under that bill', () => {
  const m = buildMonthInFull({
    month: '2026-08',
    bills: [bill()],
    transactions: [
      txn({ payee: 'CITY POWER AUTOPAY', amount: 142, posted_date: '2026-08-14', category: 'Utilities' }),
      txn({ category: 'Groceries', amount: 200 }),
    ],
  });

  assert.equal(m.bills.items.length, 1);
  assert.equal(m.bills.items[0].name, 'City Power');
  assert.equal(m.bills.items[0].source, 'tracked');
  assert.equal(m.bills.total, 142);
  assert.equal(m.rest.total, 200);
});

test('a bill nobody has tracked is still recognised from its category', () => {
  const m = buildMonthInFull({
    month: '2026-08',
    transactions: [txn({ payee: 'BRIGHT HORIZONS', category: 'Childcare', amount: 1240 })],
  });

  assert.equal(m.bills.items[0].source, 'fixed', 'inferred, and labelled as inferred');
  assert.equal(m.bills.trackedCount, 0);
  assert.equal(m.bills.total, 1240);
});

test('savings is not a bill — it is money kept, not money spent', () => {
  const m = buildMonthInFull({
    month: '2026-08',
    transactions: [
      txn({ category: 'Savings', amount: 500 }),
      txn({ category: 'Rent/Mortgage', amount: 2350 }),
    ],
  });
  assert.equal(m.bills.total, 2350);
  assert.equal(isBillCategory('Savings'), false);
});

test('subscriptions are choices, not household bills', () => {
  assert.equal(isBillCategory('Fitness'), false);
  assert.equal(isBillCategory('Subscriptions'), false);
  assert.equal(isBillCategory('Entertainment'), false);
  assert.equal(isBillCategory('Hobbies'), false);

  const m = buildMonthInFull({
    month: '2026-08',
    transactions: [
      txn({ payee: 'Google', category: 'Subscriptions', amount: 3.19 }),
      txn({ payee: 'Mortgage', category: 'Rent/Mortgage', amount: 1846.81 }),
    ],
  });
  assert.equal(m.bills.total, 1846.81);
  assert.equal(m.rest.total, 3.19);
});

test('shares are of the month, and the rest is split by category', () => {
  const m = buildMonthInFull({
    month: '2026-08',
    transactions: [
      txn({ category: 'Rent/Mortgage', amount: 750 }),
      txn({ category: 'Dining Out', amount: 150 }),
      txn({ category: 'Dining Out', amount: 50 }),
      txn({ category: 'Shopping', amount: 50 }),
    ],
  });

  assert.equal(m.bills.share, 75);
  assert.equal(m.rest.share, 25);
  assert.deepEqual(
    m.rest.categories.map((c) => [c.category, c.amount, c.count, c.share]),
    [['Dining Out', 200, 2, 80], ['Shopping', 50, 1, 20]],
  );
});

test('other months, transfers, income and pending charges are all left out', () => {
  const m = buildMonthInFull({
    month: '2026-08',
    transactions: [
      txn({ posted_date: '2026-07-30', category: 'Groceries', amount: 500 }),
      txn({ is_transfer: true, amount: 1450, category: 'Rent/Mortgage' }),
      txn({ is_income: true, amount: -2400 }),
      txn({ pending: true, amount: 60 }),
      txn({ category: 'Groceries', amount: 75 }),
    ],
  });
  assert.equal(m.total, 75);
});

test('an empty month reports zeroes rather than dividing by them', () => {
  const m = buildMonthInFull({ month: '2026-08', transactions: [] });
  assert.equal(m.total, 0);
  assert.equal(m.bills.share, 0);
  assert.equal(m.rest.share, 0);
  assert.deepEqual(m.rest.categories, []);
});

function round(n) {
  return Math.round(n * 100) / 100;
}
