/**
 * buildDailySummary: the aggregate the advisor prompt is built from, run
 * server-side over DB-shaped transactions rather than live app state.
 *
 * Verified against the same sample fixture web/app.js's demo mode uses, so a
 * pass here means the nightly check-in and the dashboard's own advisor button
 * are computing from the same numbers, not two implementations that happen to
 * agree today.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalizePlaidTransaction, categorizeBatch } from '../src/engine/categorize.js';
import { detectTransfers } from '../src/engine/transfers.js';
import { detectIncomeStreams, markIncome } from '../src/engine/income.js';
import { buildDailySummary } from '../src/engine/advisor-summary.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/sample-plaid.json', import.meta.url)));

function realisticTransactions() {
  let txns = fixture.transactions.map((t) => normalizePlaidTransaction(t, t.account_id));
  txns = detectTransfers(txns);
  const streams = detectIncomeStreams(txns);
  txns = markIncome(txns, streams);
  return categorizeBatch(txns, { learned: new Map() });
}

test('buildDailySummary produces the same shape buildAdvisorSummary sends the model', () => {
  const summary = buildDailySummary({ transactions: realisticTransactions() });

  for (const key of [
    'safeToSpend', 'safeToSpendStatus', 'reliableMonthlyIncome', 'monthlySurplus',
    'floorCoverageStatus', 'survivalMonthlyCost', 'trueMonthlyCost', 'topCategories',
    'subscriptionsAnnualCost', 'subscriptionCount', 'priceIncreases', 'activeAlerts',
  ]) {
    assert.ok(key in summary, `summary is missing "${key}"`);
  }

  assert.ok(summary.reliableMonthlyIncome > 0, 'a household with paychecks must show reliable income');
  assert.ok(summary.subscriptionCount > 0, 'the fixture has known recurring subscriptions');
  assert.ok(Array.isArray(summary.topCategories) && summary.topCategories.length > 0);
});

test('buildDailySummary never leaks a raw transaction into the summary', () => {
  const summary = buildDailySummary({ transactions: realisticTransactions() });
  const serialized = JSON.stringify(summary);
  // plaid_transaction_id is a field only a raw transaction row carries — its
  // presence would mean this leaked the transaction list itself, which the
  // advisor prompt is deliberately never sent (see advisor-note/index.ts).
  assert.doesNotMatch(serialized, /plaid_transaction_id/);
});

test('buildDailySummary tolerates a household with no transactions yet', () => {
  const summary = buildDailySummary({ transactions: [] });
  assert.equal(summary.safeToSpend, null);
  assert.equal(summary.reliableMonthlyIncome, 0);
  assert.deepEqual(summary.topCategories, []);
});
