/**
 * The year view.
 *
 * The failures that matter are both about averages telling a comfortable lie:
 * counting a month that isn't finished yet as though it were, and dividing an
 * occasional cost by twelve so it reads as a small monthly habit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildYearInReview, monthsEnding } from '../src/engine/year-in-review.js';

let seq = 0;
const txn = (over = {}) => ({
  plaid_transaction_id: `t${seq += 1}`,
  posted_date: '2026-08-12',
  payee: 'Store',
  amount: 100,
  category: 'Dining Out',
  is_transfer: false,
  is_income: false,
  pending: false,
  ...over,
});

test('twelve months are listed oldest first, crossing the year boundary', () => {
  const months = monthsEnding('2026-03', 12);
  assert.equal(months.length, 12);
  assert.equal(months[0], '2025-04');
  assert.equal(months.at(-1), '2026-03');
});

test('the month in progress counts toward totals but not toward the average', () => {
  // Dropping it would hide money already spent; averaging it in as though it
  // were a finished month makes every per-month figure read low.
  const year = buildYearInReview({
    endMonth: '2026-08',
    currentMonth: '2026-08',
    transactions: [
      txn({ posted_date: '2026-06-10', amount: 900 }),
      txn({ posted_date: '2026-07-10', amount: 1100 }),
      txn({ posted_date: '2026-08-02', amount: 100 }),
    ],
  });

  assert.equal(year.totals.spent, 2100, 'the part-month is still spending');
  assert.equal(year.typical.monthsCounted, 2);
  assert.equal(year.typical.spent, 1000, 'averaged over June and July only');
  assert.equal(year.months.at(-1).inProgress, true);
});

test('a category average is per month it happened in, never divided by twelve', () => {
  // A $600 annual premium paid twice is not "$100 a month" — that is a number
  // that has never once matched reality.
  const year = buildYearInReview({
    endMonth: '2026-08',
    currentMonth: '2026-09',
    transactions: [
      txn({ posted_date: '2026-02-01', amount: 600, category: 'Car Insurance' }),
      txn({ posted_date: '2026-08-01', amount: 600, category: 'Car Insurance' }),
    ],
  });

  const insurance = year.categories.find((c) => c.category === 'Car Insurance');
  assert.equal(insurance.total, 1200);
  assert.equal(insurance.monthsSeen, 2);
  assert.equal(insurance.perActiveMonth, 600);
});

test('each month splits into bills and everything else, and they add up', () => {
  const year = buildYearInReview({
    endMonth: '2026-08',
    currentMonth: '2026-09',
    transactions: [
      txn({ posted_date: '2026-08-01', amount: 2350, category: 'Rent/Mortgage' }),
      txn({ posted_date: '2026-08-04', amount: 220, category: 'Groceries' }),
    ],
  });

  const august = year.months.at(-1);
  assert.equal(august.bills, 2350);
  assert.equal(august.rest, 220);
  assert.equal(august.spent, 2570);
  assert.equal(year.totals.billsShare, 91);
});

test('income is counted as money in, despite being stored negative', () => {
  const year = buildYearInReview({
    endMonth: '2026-08',
    currentMonth: '2026-09',
    transactions: [
      txn({ posted_date: '2026-08-01', amount: -2400, is_income: true }),
      txn({ posted_date: '2026-08-04', amount: 500, category: 'Groceries' }),
    ],
  });
  assert.equal(year.totals.earned, 2400);
  assert.equal(year.totals.net, 1900);
  assert.equal(year.months.at(-1).net, 1900);
});

test('the worst month is named, and it is a finished one', () => {
  const year = buildYearInReview({
    endMonth: '2026-08',
    currentMonth: '2026-08',
    transactions: [
      txn({ posted_date: '2026-06-10', amount: 900 }),
      txn({ posted_date: '2026-07-10', amount: 2500 }),
      txn({ posted_date: '2026-08-10', amount: 4000 }),
    ],
  });
  assert.equal(year.biggest.month, '2026-07', 'the in-progress month cannot be the worst yet');
});

test('a year with nothing in it reports nothing rather than dividing by zero', () => {
  const year = buildYearInReview({ endMonth: '2026-08', transactions: [] });
  assert.equal(year.totals.spent, 0);
  assert.equal(year.typical.spent, null);
  assert.equal(year.biggest, null);
  assert.equal(year.months.length, 12);
});
