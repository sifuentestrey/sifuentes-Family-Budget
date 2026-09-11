import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTrackedBills, buildBillMonth } from '../src/engine/bill-center.js';
import { buildHouseholdContext } from '../src/engine/household-context.js';
import { buildHouseholdPlan } from '../src/engine/household-plan.js';

const bill = (id, dueDate = '2026-09-04', overrides = {}) => ({
  id, providerName: 'Riverdale Power', amountDue: 200, dueDate, source: 'email', status: 'confirmed', ...overrides,
});
const transaction = (id, overrides = {}) => ({ id, payee: 'Riverdale Power', amount: 200, posted_date: '2026-09-03', ...overrides });

test('one payment cannot settle overlapping invoices, regardless of bill order', () => {
  const bills = [bill('one'), bill('two', '2026-09-08')];
  for (const input of [bills, [...bills].reverse()]) {
    const result = reconcileTrackedBills(input, [transaction('payment')]);
    assert.ok(result.every(b => !b.paid && b.needsReview && !b.paidTransactionId));
  }
});

test('saved payment is reserved to its invoice, not reused for another', () => {
  const result = reconcileTrackedBills([bill('new'), bill('old', '2026-09-04', { status: 'paid', paidTransactionId: 'p' })], [transaction('p')]);
  assert.equal(result[0].paid, false);
  assert.equal(result[0].needsReview, true);
  assert.equal(result[1].paid, true);
});

test('duplicate saved links require review even when history is not loaded', () => {
  const bills = ['a', 'b'].map(id => bill(id, '2026-09-04', { status: 'paid', paidTransactionId: 'same' }));
  for (const transactions of [[], [transaction('same')]]) {
    assert.ok(reconcileTrackedBills(bills, transactions).every(b => !b.paid && b.needsReview));
  }
});

test('two possible payments are not silently chosen and ignored bills make no claims', () => {
  assert.equal(reconcileTrackedBills([bill('a')], [transaction('p1'), transaction('p2')])[0].needsReview, true);
  const result = reconcileTrackedBills([bill('a'), bill('ignored', undefined, { status: 'ignored' })], [transaction('p')]);
  assert.equal(result[0].paid, true);
});

test('small underpayments and saved partial invoice payments stay open', () => {
  for (const status of ['confirmed', 'paid']) {
    const result = reconcileTrackedBills([bill('a', undefined, { status, paidTransactionId: 'p' })], [transaction('p', { amount: 199 })]);
    assert.equal(result[0].paid, false);
    assert.equal(result[0].needsReview, true);
  }
});

test('two partial payments are not assumed to settle an invoice without allocation evidence', () => {
  const result = reconcileTrackedBills([bill('a')], [transaction('p1', { amount: 80 }), transaction('p2', { amount: 120 })]);
  assert.equal(result[0].paid, false);
  assert.equal(result[0].needsReview, true);
  assert.equal(result[0].amountDue, 200);
});

test('provider first-token similarity is not enough to mark variable bills paid', () => {
  const result = reconcileTrackedBills([bill('a', undefined, { source: 'bank', raw: { planning: { amountMode: 'variable' } } })], [transaction('p', { payee: 'Riverdale Insurance', amount: 180 })]);
  assert.equal(result[0].paid, false);
});

test('month views reconcile adjacent months together', () => {
  const bills = [bill('aug', '2026-08-31'), bill('sep', '2026-09-04')];
  for (const month of ['2026-08', '2026-09']) {
    const view = buildBillMonth({ bills, transactions: [transaction('p')], month });
    assert.equal(view.rows[0].paid, false);
    assert.equal(view.rows[0].needsReview, true);
    assert.equal(view.totals.remaining, 200);
  }
});

test('shared advisor context and planner agree about rejected saved payments', () => {
  const context = buildHouseholdContext({ asOf: '2026-09-01', rawBills: [bill('a', undefined, { status: 'paid', paidTransactionId: 'p' })], transactions: [transaction('p', { payee: 'Acme Insurance' })] });
  assert.equal(context.reconciledBills[0].paid, false);
  assert.equal(context.reconciledBills[0].status, 'confirmed');
  assert.equal(context.plan.facts.dueBeforeNextPayday.total, 200);
  assert.ok(context.plan.attention.some(a => a.type === 'bill_payment_review'));
});

const fundingInput = {
  asOf: '2026-09-11', accounts: [{ type: 'checking', available_balance: 100 }],
  paychecks: [{ date: '2026-09-18', amount: 1000 }, { date: '2026-10-02', amount: 1000 }],
  bills: [bill('large', '2026-10-04', { amountDue: 1500 })],
};

test('funding forecast carries earlier money once without claiming a reservation', () => {
  const { fundingTimeline: rows } = buildHouseholdPlan(fundingInput).forecasts;
  assert.equal(rows[0].projectedBalance, 1100);
  assert.equal(rows[1].projectedBalance, 600);
  assert.equal(rows[1].carryInNeeded, 500);
  assert.equal(rows[1].reserved, false);
});

test('funding forecast exposes a cumulative gap and does not use savings', () => {
  const plan = buildHouseholdPlan({ ...fundingInput,
    accounts: [...fundingInput.accounts, { type: 'savings', available_balance: 10000 }],
    bills: [bill('large', '2026-10-04', { amountDue: 2300 })] });
  assert.equal(plan.forecasts.fundingTimeline[1].projectedBalance, -200);
  assert.ok(plan.attention.some(a => a.type === 'future_funding_gap'));
});

test('incomplete pay makes future funding unknown rather than falsely covered', () => {
  const plan = buildHouseholdPlan({ ...fundingInput, paychecks: fundingInput.paychecks.map((p, i) => i === 0 ? { ...p, incomplete_timecard: true } : p) });
  assert.ok(plan.forecasts.fundingTimeline.every(row => row.projectedBalance === null));
});

test('funding forecast includes category budgets, not just bills', () => {
  const plan = buildHouseholdPlan({ ...fundingInput, budgetTargets: { Groceries: 600 } });
  assert.ok(plan.forecasts.fundingTimeline[0].everydayBudget > 0);
  assert.ok(plan.forecasts.fundingTimeline[1].projectedBalance < 600);
});
