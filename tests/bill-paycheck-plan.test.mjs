/**
 * Which upcoming paycheck should cover which bill — distinct from
 * allocate.js's levelled per-check funding, this ties a specific bill to a
 * specific check by due date.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeBill } from '../src/domain/bill.js';
import { planPaycheckCoverage } from '../src/engine/bill-paycheck-plan.js';

const biweekly = { payee: 'Northstar', cadence: 'biweekly', next_expected: '2026-08-15' };
const semimonthly = { payee: 'Meridian', cadence: 'semimonthly', next_expected: '2026-08-01' };

const bill = (overrides) => makeBill({
  householdId: 'h1', providerName: 'Test', amountDue: 100, dueDate: '2026-08-20', ...overrides,
});

test('a bill due before the next paycheck is flagged as needing money now', () => {
  const plan = planPaycheckCoverage([bill({ dueDate: '2026-08-10' })], [biweekly], { asOf: '2026-08-05' });
  assert.equal(plan.dueNow.bills.length, 1);
  assert.equal(plan.dueNow.total, 100);
  assert.ok(plan.groups.every((g) => g.bills.length === 0));
});

test('a bill is assigned to the latest paycheck landing on or before its due date', () => {
  const plan = planPaycheckCoverage([bill({ dueDate: '2026-08-20' })], [biweekly], { asOf: '2026-08-05' });
  const covering = plan.groups.find((g) => g.bills.length > 0);
  assert.equal(covering.paycheckDate, '2026-08-15');
  assert.equal(covering.total, 100);
});

test('a bill due exactly on a payday is covered by that payday, not the one before it', () => {
  const plan = planPaycheckCoverage([bill({ dueDate: '2026-08-15' })], [biweekly], { asOf: '2026-08-05' });
  const covering = plan.groups.find((g) => g.bills.length > 0);
  assert.equal(covering.paycheckDate, '2026-08-15');
});

test('multiple income streams merge into one paycheck timeline', () => {
  const plan = planPaycheckCoverage(
    [bill({ dueDate: '2026-08-03' })],
    [biweekly, semimonthly],
    { asOf: '2026-07-25' },
  );
  const covering = plan.groups.find((g) => g.bills.length > 0);
  assert.equal(covering.paycheckDate, '2026-08-01', 'the semimonthly check on the 1st covers a bill due the 3rd');
});

test('a bill far beyond the tracked horizon is reported separately, not guessed at', () => {
  const plan = planPaycheckCoverage(
    [bill({ dueDate: '2027-01-01' })],
    [biweekly],
    { asOf: '2026-08-05', horizonDays: 70 },
  );
  assert.equal(plan.later.bills.length, 1);
  assert.equal(plan.later.total, 100);
});

test('paid and ignored bills are excluded entirely', () => {
  const plan = planPaycheckCoverage(
    [bill({ status: 'paid' }), bill({ status: 'ignored' }), bill({ dueDate: '2026-08-20' })],
    [biweekly],
    { asOf: '2026-08-05' },
  );
  const totalBills = plan.groups.reduce((n, g) => n + g.bills.length, 0) + plan.dueNow.bills.length + plan.later.bills.length;
  assert.equal(totalBills, 1);
});

test('with no income streams at all, every unpaid bill is reported as needing money now', () => {
  const plan = planPaycheckCoverage([bill(), bill({ dueDate: '2026-09-01' })], [], { asOf: '2026-08-05' });
  assert.equal(plan.dueNow.bills.length, 2);
  assert.equal(plan.groups.length, 0);
});

test('two bills due before the same paycheck are both grouped under it, totalled together', () => {
  const plan = planPaycheckCoverage(
    [bill({ dueDate: '2026-08-16', amountDue: 60 }), bill({ dueDate: '2026-08-22', amountDue: 40 })],
    [biweekly],
    { asOf: '2026-08-05' },
  );
  const covering = plan.groups.find((g) => g.bills.length === 2);
  assert.ok(covering, 'both bills land in the same paycheck window');
  assert.equal(covering.total, 100);
});
