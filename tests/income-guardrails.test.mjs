import test from 'node:test';
import assert from 'node:assert/strict';

import { detectIncomeStreams, markIncome } from '../src/engine/income.js';

const deposit = (payee, date, amount, overrides = {}) => ({
  plaid_transaction_id: `${payee}-${date}`,
  account_id: 'checking',
  posted_date: date,
  payee,
  amount: -Math.abs(amount),
  pending: false,
  is_transfer: false,
  is_income: false,
  ...overrides,
});

test('weekly micro-deposits do not become a paycheck stream', () => {
  const txns = [
    deposit('AOC TX LLC payroll', '2026-07-10', 7.98),
    deposit('AOC TX LLC payroll', '2026-07-17', 5.74),
    deposit('AOC TX LLC payroll', '2026-07-24', 7.99),
    deposit('AOC TX LLC payroll', '2026-07-31', 5.74),
    deposit('AOC TX LLC payroll', '2026-08-07', 4.48),
  ];

  assert.deepEqual(detectIncomeStreams(txns), []);
  assert.ok(markIncome(txns, []).every((t) => t.is_income === false));
});

test('a real variable biweekly paycheck is still detected', () => {
  const txns = [
    deposit('Hospital Payroll', '2026-06-05', 4871),
    deposit('Hospital Payroll', '2026-06-18', 3046.11),
    deposit('Hospital Payroll', '2026-07-03', 3265.95),
    deposit('Hospital Payroll', '2026-07-17', 2685.23),
    deposit('Hospital Payroll', '2026-07-31', 4140.65),
  ];

  const streams = detectIncomeStreams(txns);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].payee, 'Hospital Payroll');
  assert.equal(streams[0].cadence, 'biweekly');
  assert.ok(streams[0].typical_amount > 2500);

  const marked = markIncome(txns, streams);
  assert.ok(marked.every((t) => t.is_income === true));
});

test('a previously marked inflow is cleared when it no longer qualifies', () => {
  const txns = [
    deposit('Tiny Payroll', '2026-07-18', 5, { is_income: true }),
    deposit('Tiny Payroll', '2026-07-25', 5, { is_income: true }),
    deposit('Tiny Payroll', '2026-08-01', 5, { is_income: true }),
    deposit('Tiny Payroll', '2026-08-08', 5, { is_income: true }),
  ];

  const streams = detectIncomeStreams(txns);
  assert.equal(streams.length, 0);
  assert.ok(markIncome(txns, streams).every((t) => t.is_income === false));
});
