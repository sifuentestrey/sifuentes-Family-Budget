import test from 'node:test';
import assert from 'node:assert/strict';

import { detectTransfers, hasTransferEvidence } from '../src/engine/transfers.js';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('unrelated equal-amount Zelle send and receipt do not become a transfer pair', () => {
  const rows = detectTransfers([
    {
      id: uuid(1), account_id: 'savings', posted_date: '2026-07-03', amount: 10,
      payee: 'Payment To Jocelyn Valdez Conf',
      raw_description: 'Zelle payment to JOCELYN VALDEZ Conf# raj6bqoig',
    },
    {
      id: uuid(2), account_id: 'checking', posted_date: '2026-07-06', amount: -10,
      payee: 'Payment From Quintin B Walker',
      raw_description: 'Zelle payment from QUINTIN B WALKER Conf# 99coiqww6',
    },
  ]);

  assert.equal(hasTransferEvidence(rows[0]), false);
  assert.equal(hasTransferEvidence(rows[1]), false);
  assert.equal(rows[0].is_transfer, false);
  assert.equal(rows[1].is_transfer, false);
  assert.equal(rows[0].transfer_pair_id, null);
  assert.equal(rows[1].transfer_pair_id, null);
});

test('same amount across two accounts is not enough without transfer evidence', () => {
  const rows = detectTransfers([
    { id: uuid(3), account_id: 'a', posted_date: '2026-08-01', amount: 25, payee: 'Restaurant', raw_description: 'Restaurant purchase' },
    { id: uuid(4), account_id: 'b', posted_date: '2026-08-02', amount: -25, payee: 'Refund from Friend', raw_description: 'P2P receipt' },
  ]);

  assert.equal(rows[0].is_transfer, false);
  assert.equal(rows[1].is_transfer, false);
});

test('internal checking-to-savings transfer still pairs with evidence', () => {
  const rows = detectTransfers([
    {
      id: uuid(5), account_id: 'checking', posted_date: '2026-08-10', amount: 100,
      payee: 'Online Banking Transfer To Sav 7706',
      raw_description: 'Online Banking transfer to SAV 7706 Confirmation# ABC123',
    },
    {
      id: uuid(6), account_id: 'savings', posted_date: '2026-08-10', amount: -100,
      payee: 'Online Banking Transfer From Chk 0370',
      raw_description: 'Online Banking transfer from CHK 0370 Confirmation# ABC123',
    },
  ]);

  assert.equal(rows[0].is_transfer, true);
  assert.equal(rows[1].is_transfer, true);
  assert.equal(rows[0].transfer_pair_id, uuid(6));
  assert.equal(rows[1].transfer_pair_id, uuid(5));
});

test('reprocessing clears a stale false-positive transfer flag', () => {
  const [row] = detectTransfers([{
    id: uuid(7), account_id: 'checking', posted_date: '2026-08-01', amount: 42,
    payee: 'Ordinary Purchase', raw_description: 'ordinary purchase',
    is_transfer: true,
    transfer_pair_id: uuid(8),
  }]);

  assert.equal(row.is_transfer, false);
  assert.equal(row.transfer_pair_id, null);
});

test('generic autopay and bill pay text are not enough to erase an expense', () => {
  const rows = detectTransfers([
    { id: uuid(9), account_id: 'checking', posted_date: '2026-08-01', amount: 80, payee: 'Utility', raw_description: 'AUTOPAY ELECTRIC BILL' },
    { id: uuid(10), account_id: 'checking', posted_date: '2026-08-02', amount: 65, payee: 'Water Utility', raw_description: 'BILL PAY WATER' },
  ]);

  assert.equal(rows[0].is_transfer, false);
  assert.equal(rows[1].is_transfer, false);
});
