import test from 'node:test';
import assert from 'node:assert/strict';
import { findPayingTransaction } from '../src/domain/bill-payment-match.js';
import { buildBillMonth } from '../src/engine/bill-center.js';

test('Kaufman County water payment posted a week after due date counts as paid', () => {
  const bill = {
    id: 'water-aug',
    providerName: 'Kaufman County Mu',
    category: 'Utilities',
    amountDue: 121.70,
    dueDate: '2026-08-06',
    status: 'confirmed',
    source: 'bank',
  };
  const transaction = {
    id: 'water-payment',
    account_id: 'checking',
    payee: 'Kaufman County Mu',
    amount: 121.70,
    posted_date: '2026-08-13',
    pending: false,
    is_transfer: false,
    is_income: false,
  };

  assert.equal(findPayingTransaction(bill, [transaction])?.id, 'water-payment');

  const month = buildBillMonth({
    bills: [bill],
    recurring: [],
    transactions: [transaction],
    month: '2026-08',
  });
  assert.equal(month.rows.length, 1);
  assert.equal(month.rows[0].paid, true);
  assert.equal(month.rows[0].paidDate, '2026-08-13');
  assert.equal(month.rows[0].paidAmount, 121.70);
});
