import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHouseholdPlan } from '../src/engine/household-plan.js';
import { buildHouseholdContext } from '../src/engine/household-context.js';
import { findPayingTransaction } from '../src/domain/bill-payment-match.js';
import { buildBillMonth, reconcileTrackedBill } from '../src/engine/bill-center.js';
test('saved paid status cannot use another provider payment', () => {
  const bill = { providerName: 'Riverdale Water', amountDue: 120, dueDate: '2026-09-04', status: 'paid', paidTransactionId: 'insurance', paidAmount: 121 };
  const transactions = [{ id: 'insurance', payee: 'Acme Insurance', amount: 121, posted_date: '2026-09-03' }];
  assert.equal(reconcileTrackedBill(bill, transactions).paid, false);
  assert.equal(reconcileTrackedBill({ ...bill, providerName: 'Acme Insurance' }, transactions).paid, true);
});
const stream = { account_id: 'a', payee: 'Example employer', next_expected: '2026-09-18', typical_amount: 2000, cadence: 'biweekly' };
test('paycheck allowance includes yesterday and keeps its original period tomorrow', () => {
  const input = { asOf: '2026-09-11', incomeStreams: [stream], budgetTargets: { Groceries: 600 }, transactions: [
    { posted_date: '2026-09-04', amount: -2000, is_income: true },
    { posted_date: '2026-09-10', amount: 150, category: 'Groceries' },
    { posted_date: '2026-09-11', amount: 20, category: 'Groceries', pending: true },
  ] };
  const today = buildHouseholdPlan(input), tomorrow = buildHouseholdPlan({ ...input, asOf: '2026-09-12' });
  assert.equal(today.allowances[0].planned, 280);
  assert.equal(today.allowances[0].spent, 170);
  assert.equal(today.allowances[0].left, 110);
  assert.equal(tomorrow.allowances[0].left, 110);
});
test('two incomes sharing payday are one combined paycheck with subsequent paydays', () => {
  const plan = buildHouseholdPlan({ asOf: '2026-09-11', incomeStreams: [stream, { ...stream, account_id: 'b', payee: 'Other employer', typical_amount: 1000 }] });
  assert.equal(plan.forecasts.nextPaycheck.amount, 3000);
  assert.equal(plan.forecasts.followingPaycheck.date, '2026-10-02');
  assert.ok(plan.forecasts.paycheckGroups.length >= 4);
});
test('payroll replaces only its matched deposit and preserves spouse income', () => {
  const plan = buildHouseholdPlan({ asOf: '2026-09-11', incomeStreams: [stream, { ...stream, account_id: 'b', typical_amount: 1000 }],
    paychecks: [{ date: '2026-09-18', amount: 2500, status: 'verified', streamId: 'a:Example employer' }] });
  assert.equal(plan.forecasts.nextPaycheck.amount, 3500);
});
test('unrelated equal amount cannot settle a bill', () => {
  assert.equal(findPayingTransaction({ providerName: 'Electric company', amountDue: 100, dueDate: '2026-09-15' },
    [{ id: 't', payee: 'Grocery store', amount: 100, posted_date: '2026-09-15' }]), null);
});
test('partial payment cannot falsely settle a fixed bill in monthly view', () => {
  const r = buildBillMonth({ month: '2026-09', bills: [{ id: 'b', providerName: 'Mortgage lender', amountDue: 1800, dueDate: '2026-09-01' }],
    transactions: [{ id: 't', payee: 'Mortgage lender', amount: 500, posted_date: '2026-09-02' }], recurring: [] });
  assert.equal(r.rows[0].paid, false);
});
test('early mortgage appears in its due month and not as two paid bills', () => {
  const input = { bills: [{ id: 'b', providerName: 'Mortgage lender', amountDue: 1800, dueDate: '2026-09-01' }],
    transactions: [{ id: 't', payee: 'Mortgage lender', amount: 1800, posted_date: '2026-08-28' }],
    recurring: [{ payee: 'Mortgage lender', dates: ['2026-08-28'], amounts: [1800], next_expected: '2026-09-28', cadence: 'monthly' }] };
  const september = buildBillMonth({ ...input, month: '2026-09' });
  assert.equal(september.rows.find(r => r.trackedBillId === 'b').paidDate, '2026-08-28');
  assert.equal(buildBillMonth({ ...input, month: '2026-08' }).totals.paidCount, 0);
});
test('checking subtype and missing available balances fall back correctly', () => {
  const p = buildHouseholdPlan({ asOf: '2026-09-11', accounts: [{ type: 'depository', subtype: 'checking', available_balance: null, current_balance: 300 }] });
  assert.equal(p.facts.checking.available, 300);
});
test('shared context uses paid status consistently and flags missing targets', () => {
  const c = buildHouseholdContext({ asOf: '2026-08-29', rawBills: [{ id: 'b', providerName: 'Mortgage lender', amountDue: 1800, dueDate: '2026-09-01' }],
    transactions: [{ id: 't', payee: 'Mortgage lender', amount: 1800, posted_date: '2026-08-28' }] });
  assert.equal(c.planningBills[0].paid, true);
  assert.equal(c.plan.facts.dueBeforeNextPayday.total, 0);
  assert.equal(c.dataHealth.missingBudgetTargets, true);
});
