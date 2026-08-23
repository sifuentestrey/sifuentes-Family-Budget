import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHouseholdPlan } from '../src/engine/household-plan.js';

const bill = (providerName, amountDue, dueDate, extra = {}) => ({
  providerName, amountDue, dueDate, status: 'open', ...extra,
});

test('keeps checking and savings as separate facts and never adds them together', () => {
  const plan = buildHouseholdPlan({
    asOf: '2026-08-22',
    accounts: [
      { type: 'checking', available_balance: 197.65, current_balance: 415.61 },
      { type: 'savings', available_balance: 611.12, current_balance: 611.12 },
    ],
  });

  assert.equal(plan.facts.checking.available, 197.65);
  assert.equal(plan.facts.savings.available, 611.12);
  assert.equal('cash' in plan.facts, false);
});

test('uses exact bill amounts over recurring estimates and assigns each bill to the latest payday before it is due', () => {
  const plan = buildHouseholdPlan({
    asOf: '2026-08-22',
    accounts: [{ type: 'checking', available_balance: 500 }],
    paychecks: [
      { date: '2026-08-28', expected_amount: 2500, status: 'forecast' },
      { date: '2026-09-11', expected_amount: 2500, status: 'forecast' },
    ],
    bills: [
      bill('Mortgage', 1800, '2026-09-01', { verifiedAmount: true }),
      bill('Electric', 210, '2026-09-10'),
      bill('Car payment', 400, '2026-09-12'),
    ],
  });

  assert.equal(plan.forecasts.nextPaycheckPlan.billsTotal, 2010);
  assert.deepEqual(plan.forecasts.nextPaycheckPlan.bills.map((item) => item.providerName), ['Mortgage', 'Electric']);
  assert.equal(plan.forecasts.nextPaycheckPlan.bills[0].amountSource, 'verified amount');
  assert.equal(plan.forecasts.later.length, 0);
});

test('does not present an incomplete timecard as final or use it in the expected after-plan number', () => {
  const plan = buildHouseholdPlan({
    asOf: '2026-08-22',
    accounts: [{ type: 'checking', available_balance: 500 }],
    paychecks: [{ date: '2026-08-28', expected_amount: 2500, incomplete_timecard: true }],
    bills: [bill('Mortgage', 1800, '2026-09-01')],
  });

  assert.equal(plan.forecasts.nextPaycheck.isFinal, false);
  assert.equal(plan.forecasts.nextPaycheckPlan.expectedCheckingAfterAssignedBills, null);
  assert.equal(plan.attention[0].type, 'incomplete_paycheck');
});

test('explains the specific bill gap before payday', () => {
  const plan = buildHouseholdPlan({
    asOf: '2026-08-22',
    accounts: [{ type: 'checking', available_balance: 100 }],
    paychecks: [{ date: '2026-08-28', expected_amount: 1000 }],
    bills: [bill('Insurance', 225, '2026-08-26')],
  });

  assert.equal(plan.facts.dueBeforeNextPayday.total, 225);
  assert.equal(plan.attention[0].type, 'coverage_gap_before_payday');
  assert.match(plan.attention[0].reason, /225.00/);
  assert.match(plan.attention[0].reason, /100.00/);
});

test('calculates flexible-category allowance by actual days until payday without treating transfers as spending', () => {
  const plan = buildHouseholdPlan({
    asOf: '2026-08-22',
    paychecks: [{ date: '2026-08-29', expected_amount: 2000 }],
    budgetTargets: { Restaurants: 310 },
    flexibleCategories: ['Restaurants'],
    transactions: [
      { posted_date: '2026-08-23', category: 'Restaurants', amount: 30 },
      { posted_date: '2026-08-24', category: 'Restaurants', amount: 70, is_transfer: true },
    ],
  });

  assert.equal(plan.allowances[0].spent, 30);
  assert.equal(plan.allowances[0].daysRemaining, 7);
  assert.ok(plan.allowances[0].planned > 60);
  assert.ok(plan.allowances[0].left > 0);
});
