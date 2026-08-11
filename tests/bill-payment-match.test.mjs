/**
 * Bill-to-transaction reconciliation: recognizing that a bill already got
 * paid through the connected bank account, so it stops sitting in "upcoming"
 * after the household has already handled it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeBill } from '../src/domain/bill.js';
import { findPayingTransaction } from '../src/domain/bill-payment-match.js';

const txn = (overrides) => ({
  id: 't1', payee: 'Netflix', amount: 17.99, posted_date: '2026-08-08',
  is_transfer: false, is_income: false, pending: false, ...overrides,
});

test('a same-amount transaction near the due date is matched', () => {
  const bill = makeBill({ providerName: 'Netflix', amountDue: 17.99, dueDate: '2026-08-08' });
  const match = findPayingTransaction(bill, [txn()]);
  assert.equal(match?.id, 't1');
});

test('a transaction paid a few days after the due date still matches', () => {
  const bill = makeBill({ providerName: 'Netflix', amountDue: 17.99, dueDate: '2026-08-05' });
  const match = findPayingTransaction(bill, [txn({ posted_date: '2026-08-10' })]);
  assert.equal(match?.id, 't1');
});

test('a transaction weeks outside the due-date window is not matched', () => {
  const bill = makeBill({ providerName: 'Netflix', amountDue: 17.99, dueDate: '2026-08-05' });
  const match = findPayingTransaction(bill, [txn({ posted_date: '2026-09-15' })]);
  assert.equal(match, null);
});

test('a pending transaction is never treated as having paid the bill', () => {
  const bill = makeBill({ providerName: 'Netflix', amountDue: 17.99, dueDate: '2026-08-08' });
  const match = findPayingTransaction(bill, [txn({ pending: true })]);
  assert.equal(match, null);
});

test('a transfer or income row is never treated as a bill payment', () => {
  const bill = makeBill({ providerName: 'Netflix', amountDue: 17.99, dueDate: '2026-08-08' });
  assert.equal(findPayingTransaction(bill, [txn({ is_transfer: true })]), null);
  assert.equal(findPayingTransaction(bill, [txn({ is_income: true })]), null);
});

test('two candidates in range are only resolved when exactly one names the provider', () => {
  const bill = makeBill({ providerName: 'Netflix', amountDue: 17.99, dueDate: '2026-08-08' });
  const ambiguous = [
    txn({ id: 'a', payee: 'Some Store' }),
    txn({ id: 'b', payee: 'Another Store' }),
  ];
  // Neither names the provider — a coincidence of amount and timing is not
  // enough on its own to mark someone else's bill paid.
  assert.equal(findPayingTransaction(bill, ambiguous), null);

  const oneNamed = [
    txn({ id: 'a', payee: 'Some Store' }),
    txn({ id: 'b', payee: 'Netflix.com' }),
  ];
  assert.equal(findPayingTransaction(bill, oneNamed)?.id, 'b');
});

test('an amount too far off is not matched even on the due date', () => {
  const bill = makeBill({ providerName: 'Netflix', amountDue: 17.99, dueDate: '2026-08-08' });
  const match = findPayingTransaction(bill, [txn({ amount: 45.00 })]);
  assert.equal(match, null);
});
