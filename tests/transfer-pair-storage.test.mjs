import test from 'node:test';
import assert from 'node:assert/strict';

import { detectTransfers } from '../src/engine/transfers.js';

const OUT_UUID = '11111111-1111-4111-8111-111111111111';
const IN_UUID = '22222222-2222-4222-8222-222222222222';

test('paired database transactions store the counterpart UUID, never the Plaid id', () => {
  const rows = detectTransfers([
    {
      id: OUT_UUID,
      plaid_transaction_id: 'plaid-out-external-id',
      account_id: 'checking',
      posted_date: '2026-08-01',
      amount: 500,
      payee: 'Transfer to savings',
      raw_description: 'transfer',
      pending: false,
    },
    {
      id: IN_UUID,
      plaid_transaction_id: 'plaid-in-external-id',
      account_id: 'savings',
      posted_date: '2026-08-01',
      amount: -500,
      payee: 'Transfer from checking',
      raw_description: 'transfer',
      pending: false,
    },
  ]);

  assert.equal(rows[0].is_transfer, true);
  assert.equal(rows[1].is_transfer, true);
  assert.equal(rows[0].transfer_pair_id, IN_UUID);
  assert.equal(rows[1].transfer_pair_id, OUT_UUID);
  assert.notEqual(rows[0].transfer_pair_id, rows[1].plaid_transaction_id);
});

test('in-memory transfer fixtures without database ids are still flagged without inventing a foreign key', () => {
  const rows = detectTransfers([
    {
      plaid_transaction_id: 'plaid-out-external-id',
      account_id: 'checking',
      posted_date: '2026-08-01',
      amount: 125,
      payee: 'Transfer',
      raw_description: 'transfer',
      pending: false,
    },
    {
      plaid_transaction_id: 'plaid-in-external-id',
      account_id: 'savings',
      posted_date: '2026-08-02',
      amount: -125,
      payee: 'Transfer',
      raw_description: 'transfer',
      pending: false,
    },
  ]);

  assert.equal(rows[0].is_transfer, true);
  assert.equal(rows[1].is_transfer, true);
  assert.equal(rows[0].transfer_pair_id, null);
  assert.equal(rows[1].transfer_pair_id, null);
});
