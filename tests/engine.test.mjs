/**
 * Engine tests. Everything runs offline against synthetic fixtures — no bank
 * connection, no network, no real data.
 *
 * Run: node --test tests/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cleanPayee, payeeKey } from '../src/engine/normalize.js';
import {
  normalizePlaidTransaction,
  categorizeBatch,
  buildLearnedIndex,
  categorizationStats,
} from '../src/engine/categorize.js';
import { detectTransfers, totalSpending } from '../src/engine/transfers.js';
import {
  detectIncomeStreams,
  markIncome,
  inferCadence,
  projectMonthlyIncome,
} from '../src/engine/income.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/sample-plaid.json', import.meta.url)));

/** Full pipeline, mirroring what the sync function does. */
function runPipeline(learnedRules = []) {
  let txns = fixture.transactions.map((t) => normalizePlaidTransaction(t, t.account_id));
  txns = detectTransfers(txns);
  const streams = detectIncomeStreams(txns);
  txns = markIncome(txns, streams);
  txns = categorizeBatch(txns, { learned: buildLearnedIndex(learnedRules) });
  return { txns, streams };
}

// ---------------------------------------------------------------------------
// Payee normalization
// ---------------------------------------------------------------------------

test('cleanPayee strips processor, store, and location noise', () => {
  assert.equal(cleanPayee('SQ *BLUE BOTTLE COFFEE #4412 OAKLAND CA'), 'Blue Bottle Coffee');
  assert.equal(cleanPayee('PURCHASE AUTHORIZED ON 07/14 SAFEWAY #1234 SAN FRANCISCO CA'), 'Safeway');
  assert.equal(cleanPayee('POS DEBIT 07/14 TRADER JOES #123'), 'Trader Joes');
  assert.equal(cleanPayee('COSTCO WHSE #0472 SEATTLE WA'), 'Costco');
  assert.equal(cleanPayee('NETFLIX.COM'), 'Netflix');
});

test('cleanPayee resolves processor-owned merchants rather than parsing refs', () => {
  // The reference code is not a merchant name.
  assert.equal(cleanPayee('AMZN Mktp US*RT4G59DK3'), 'Amazon');
});

test('cleanPayee prefers Plaid merchant_name when present', () => {
  assert.equal(cleanPayee('SQ *GARBAGE STRING #99', 'Blue Bottle Coffee'), 'Blue Bottle Coffee');
});

test('cleanPayee is stable across formatting variants', () => {
  // Stability is what keeps learned rules matching. If these diverge, a user's
  // corrections silently stop applying.
  const a = cleanPayee('SAFEWAY #1234 SAN FRANCISCO CA');
  const b = cleanPayee('SAFEWAY #9876 OAKLAND CA');
  assert.equal(payeeKey(a), payeeKey(b));
});

test('cleanPayee never returns empty', () => {
  assert.equal(cleanPayee(''), 'Unknown');
  assert.equal(cleanPayee('   '), 'Unknown');
  assert.equal(cleanPayee('#### 1234'), 'Unknown');
});

// ---------------------------------------------------------------------------
// Transfer detection — the highest-stakes logic in the app
// ---------------------------------------------------------------------------

test('credit card payment is paired and flagged on both sides', () => {
  const { txns } = runPipeline();
  const outflow = txns.find((t) => t.plaid_transaction_id && t.amount === 1450.0);
  const inflow = txns.find((t) => t.amount === -1450.0);

  assert.ok(outflow.is_transfer, 'checking side must be flagged');
  assert.ok(inflow.is_transfer, 'card side must be flagged');
  assert.ok(outflow.transfer_pair_id, 'pair must be linked');
});

test('card payment is excluded from spending', () => {
  const { txns } = runPipeline();
  const spending = txns.filter((t) => !t.is_transfer && !t.is_income && t.amount > 0);
  assert.ok(
    !spending.some((t) => t.amount === 1450.0),
    'a card payment counted as spending inflates the budget by its full amount',
  );
});

test('checking to savings transfer is excluded', () => {
  const { txns } = runPipeline();
  const move = txns.find((t) => t.amount === 800.0);
  assert.ok(move.is_transfer, 'saving is not spending');
});

test('unpaired transfer is caught by keyword when counterpart is unlinked', () => {
  const { txns } = runPipeline();
  const amex = txns.find((t) => t.amount === 640.18);
  assert.ok(amex.is_transfer, 'AMEX EPAYMENT has no linked counterpart but is still a transfer');
});

test('transfer pairing is one-to-one', () => {
  // Two identical $1,450 payments in the same window must produce two distinct
  // pairs, not a four-way tangle.
  const txns = [
    { plaid_transaction_id: 'a', account_id: 'chk', posted_date: '2026-07-05', amount: 500, payee: 'X', raw_description: '' },
    { plaid_transaction_id: 'b', account_id: 'chk', posted_date: '2026-07-06', amount: 500, payee: 'X', raw_description: '' },
    { plaid_transaction_id: 'c', account_id: 'crd', posted_date: '2026-07-05', amount: -500, payee: 'Y', raw_description: '' },
    { plaid_transaction_id: 'd', account_id: 'crd', posted_date: '2026-07-06', amount: -500, payee: 'Y', raw_description: '' },
  ];
  const out = detectTransfers(txns);
  assert.ok(out.every((t) => t.is_transfer), 'all four should pair up');
  const pairs = new Set(out.map((t) => [t.plaid_transaction_id, t.transfer_pair_id].sort().join('-')));
  assert.equal(pairs.size, 2, 'exactly two distinct pairs');
});

test('same-account opposite amounts are not a transfer', () => {
  // A refund from the same merchant on the same card is not a transfer.
  const txns = [
    { plaid_transaction_id: 'a', account_id: 'crd', posted_date: '2026-07-05', amount: 75, payee: 'Store', raw_description: '' },
    { plaid_transaction_id: 'b', account_id: 'crd', posted_date: '2026-07-06', amount: -75, payee: 'Store', raw_description: '' },
  ];
  const out = detectTransfers(txns);
  assert.ok(!out[0].is_transfer && !out[1].is_transfer);
});

// ---------------------------------------------------------------------------
// Income detection and pay cadence
// ---------------------------------------------------------------------------

test('inferCadence separates biweekly from semi-monthly', () => {
  // Biweekly: consistent 14-day gaps.
  assert.equal(
    inferCadence(['2026-07-03', '2026-07-17', '2026-07-31', '2026-08-14']),
    'biweekly',
  );
  // Semi-monthly: 1st and 15th, gaps alternating ~14 and ~16.
  assert.equal(
    inferCadence(['2026-06-01', '2026-06-15', '2026-07-01', '2026-07-15', '2026-08-01']),
    'semimonthly',
  );
});

test('both earners detected with correct cadences', () => {
  const { streams } = runPipeline();
  assert.equal(streams.length, 2, 'two income streams');

  const biweekly = streams.find((s) => s.cadence === 'biweekly');
  const semi = streams.find((s) => s.cadence === 'semimonthly');
  assert.ok(biweekly, 'biweekly earner detected');
  assert.ok(semi, 'semi-monthly earner detected');
  assert.equal(biweekly.typical_amount, 2184.62);
  assert.equal(semi.typical_amount, 1912.4);
});

test('three-paycheck month is projected correctly', () => {
  // July 2026 gives the biweekly earner deposits on the 3rd, 17th and 31st.
  // A budget assuming "biweekly = 2x/month" under-counts July by a full check —
  // the error that makes two-earner budgets drift every month.
  const { streams } = runPipeline();
  const biweekly = streams.filter((s) => s.cadence === 'biweekly');
  const july = projectMonthlyIncome(biweekly, 2026, 7);
  assert.equal(july.detail[0].paychecks, 3, 'July 2026 is a three-paycheck month');

  const august = projectMonthlyIncome(biweekly, 2026, 8);
  assert.equal(august.detail[0].paychecks, 2, 'August is an ordinary two-paycheck month');
});

test('semi-monthly earner always gets exactly two paychecks', () => {
  const { streams } = runPipeline();
  const semi = streams.filter((s) => s.cadence === 'semimonthly');
  for (const month of [7, 8, 9]) {
    assert.equal(projectMonthlyIncome(semi, 2026, month).detail[0].paychecks, 2);
  }
});

test('income is not counted as negative spending', () => {
  const { txns } = runPipeline();
  const paychecks = txns.filter((t) => t.is_income);
  assert.ok(paychecks.length > 0);
  assert.ok(paychecks.every((t) => t.amount < 0));
  // totalSpending must ignore them entirely.
  assert.ok(totalSpending(txns) > 0);
});

test('transfers are never counted as income', () => {
  const { txns, streams } = runPipeline();
  const transferInflows = txns.filter((t) => t.is_transfer && t.amount < 0);
  assert.ok(transferInflows.length > 0, 'fixture has transfer inflows');
  assert.ok(
    transferInflows.every((t) => !t.is_income),
    'moving your own money between accounts is not income',
  );
  assert.ok(!streams.some((s) => s.payee.toLowerCase().includes('transfer')));
});

// ---------------------------------------------------------------------------
// Categorization
// ---------------------------------------------------------------------------

test('learned rules outrank every automated layer', () => {
  // Costco defaults to Groceries via seed rules. A learned rule must win.
  const base = runPipeline();
  const costcoBefore = base.txns.find((t) => t.payee === 'Costco');
  assert.equal(costcoBefore.category, 'Groceries');
  assert.equal(costcoBefore.categorized_by, 'rule');

  const withLearned = runPipeline([
    { pattern: 'Costco', category: 'Shopping', is_learned: true },
  ]);
  const costcoAfter = withLearned.txns.find((t) => t.payee === 'Costco');
  assert.equal(costcoAfter.category, 'Shopping');
  assert.equal(costcoAfter.categorized_by, 'learned');
});

test('manual categorization survives a re-sync', () => {
  const { txns } = runPipeline();
  const target = { ...txns.find((t) => t.payee === 'Safeway') };
  target.category = 'Dining Out';
  target.manually_categorized = true;

  const recategorized = categorizeBatch([target], { learned: new Map() });
  assert.equal(recategorized[0].category, 'Dining Out', 'a re-sync must not undo a human correction');
});

test('more specific keyword rule wins over a shorter one', () => {
  const { txns } = runPipeline();
  const wholeFoods = txns.find((t) => t.payee.toLowerCase().includes('whole foods'));
  assert.equal(wholeFoods.category, 'Groceries');
});

test('Plaid category fills gaps the keyword rules miss', () => {
  const { txns } = runPipeline();
  const rent = txns.find((t) => t.payee.toLowerCase().includes('rent payment'));
  assert.equal(rent.category, 'Rent/Mortgage');
  assert.equal(rent.categorized_by, 'plaid_pfc');
});

test('unknown payee lands in the review queue, not a wrong category', () => {
  const { txns } = runPipeline();
  const unknown = txns.find((t) => t.raw_description.includes('HRTLND'));
  assert.equal(unknown.category, null);
  assert.equal(unknown.categorized_by, 'none', 'guessing silently is worse than admitting ignorance');
});

test('every transaction records which layer decided it', () => {
  const { txns } = runPipeline();
  const valid = new Set(['learned', 'rule', 'plaid_pfc', 'llm', 'split', 'none']);
  assert.ok(txns.every((t) => valid.has(t.categorized_by)), 'every category must be explainable');
});

test('categorization coverage is high enough to be useful', () => {
  const { txns } = runPipeline();
  const spending = txns.filter((t) => !t.is_transfer && !t.is_income);
  const stats = categorizationStats(spending);
  assert.ok(
    stats.coverage >= 90,
    `coverage ${stats.coverage}% — seed rules need tuning if this drops`,
  );
});

// ---------------------------------------------------------------------------
// Totals and idempotency
// ---------------------------------------------------------------------------

test('pending transactions are excluded from totals', () => {
  const { txns } = runPipeline();
  const pending = txns.find((t) => t.pending);
  assert.ok(pending, 'fixture has a pending transaction');
  const withPending = totalSpending(txns);
  const withoutPending = totalSpending(txns.filter((t) => !t.pending));
  assert.equal(withPending, withoutPending, 'pending must not move the total');
});

test('split children replace the parent in totals, never double-count', () => {
  const parent = {
    id: 'p1', plaid_transaction_id: 'p1', account_id: 'crd',
    posted_date: '2026-07-07', amount: 312.44, payee: 'Costco',
    raw_description: '', is_transfer: false, is_income: false, pending: false,
  };
  const children = [
    { id: 'c1', parent_transaction_id: 'p1', account_id: 'crd', posted_date: '2026-07-07', amount: 200.00, payee: 'Costco', raw_description: '', category: 'Groceries', is_transfer: false, is_income: false, pending: false },
    { id: 'c2', parent_transaction_id: 'p1', account_id: 'crd', posted_date: '2026-07-07', amount: 112.44, payee: 'Costco', raw_description: '', category: 'Shopping', is_transfer: false, is_income: false, pending: false },
  ];

  const total = totalSpending([parent, ...children]);
  assert.equal(total, 312.44, 'the split must count once, not twice');
  assert.equal(
    children.reduce((s, c) => s + c.amount, 0),
    parent.amount,
    'children must sum to the parent',
  );
});

test('pipeline is idempotent', () => {
  // Re-running must produce identical results — the sync function re-processes
  // an overlapping window on every run.
  const first = runPipeline();
  const second = runPipeline();
  assert.equal(first.txns.length, second.txns.length);
  assert.deepEqual(
    first.txns.map((t) => [t.plaid_transaction_id, t.category, t.is_transfer, t.is_income]),
    second.txns.map((t) => [t.plaid_transaction_id, t.category, t.is_transfer, t.is_income]),
  );
});

test('spending total excludes transfers and income together', () => {
  const { txns } = runPipeline();
  // Exclude pending from the naive total too, so the only variable under test
  // is transfer handling.
  const naive = txns
    .filter((t) => t.amount > 0 && !t.pending)
    .reduce((s, t) => s + t.amount, 0);
  const correct = totalSpending(txns);

  // The gap is exactly the transfers: 1450 + 1102.35 + 800 + 640.18 = 3992.53.
  // That is what a tool without transfer detection would over-report — here,
  // more than the household's entire monthly grocery and dining spend combined.
  assert.equal(Number((naive - correct).toFixed(2)), 3992.53);
});
