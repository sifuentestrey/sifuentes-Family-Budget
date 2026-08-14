import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMoneyPlanSummary } from '../src/engine/money-plan-summary.js';

const stream = {
  account_id: 'checking',
  payee: 'Hospital Payroll',
  cadence: 'biweekly',
  typical_amount: 3200,
  next_expected: '2026-08-28',
};

const bill = (name, amountDue, dueDate) => ({
  id: name,
  providerName: name,
  amountDue,
  dueDate,
  status: 'confirmed',
});

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

test('shows what the next paycheck has to cover and what remains uncommitted', () => {
  const summary = buildMoneyPlanSummary({
    asOf: '2026-08-14',
    incomeStreams: [stream],
    upcomingBills: [
      bill('Mortgage', 1846.81, '2026-09-01'),
      bill('Electric', 428, '2026-09-03'),
      bill('Car', 569.42, '2026-09-04'),
    ],
    budgetTargets: { Groceries: 800, Gas: 300 },
    transactions: [],
  });

  assert.equal(summary.nextPayday, '2026-08-28');
  assert.equal(summary.followingPayday, '2026-09-11');
  assert.equal(summary.paycheckEstimate, 3200);
  assert.equal(summary.bills.total, 2844.23);
  assert.ok(summary.essentials.expected > 0);
  assert.ok(summary.uncommitted < 3200 - 2844.23);
});

test('flags a heavy group of bills immediately after payday', () => {
  const summary = buildMoneyPlanSummary({
    asOf: '2026-08-14',
    incomeStreams: [stream],
    upcomingBills: [
      bill('Mortgage', 1846.81, '2026-09-01'),
      bill('Insurance', 123.95, '2026-09-03'),
      bill('Electric', 428, '2026-09-03'),
      bill('Car', 569.42, '2026-09-04'),
    ],
    transactions: [],
  });

  assert.ok(summary.heavyCluster);
  assert.equal(summary.heavyCluster.start, '2026-09-01');
  assert.equal(summary.heavyCluster.end, '2026-09-04');
  assert.equal(summary.heavyCluster.count, 4);
});

test('adaptive grocery and gas history flows into the paycheck plan', () => {
  const transactions = [
    txn('2026-05-08', 'Groceries', 700), txn('2026-05-12', 'Gas', 220),
    txn('2026-06-08', 'Groceries', 760), txn('2026-06-12', 'Gas', 250),
    txn('2026-07-08', 'Groceries', 820), txn('2026-07-12', 'Gas', 280),
  ];
  const summary = buildMoneyPlanSummary({
    asOf: '2026-08-14',
    incomeStreams: [stream],
    upcomingBills: [],
    transactions,
  });

  assert.ok(summary.essentials.expected > 400);
  assert.ok(summary.essentials.high >= summary.essentials.low);
  assert.ok(summary.essentials.detail.some((row) => row.category === 'Groceries'));
});
