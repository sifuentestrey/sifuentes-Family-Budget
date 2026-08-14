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
  plaidCategoryOf,
} from '../src/engine/categorize.js';
import { detectTransfers, totalSpending } from '../src/engine/transfers.js';
import { PFC_PRIMARY_MAP, PFC_DETAILED_MAP } from '../src/engine/seed-rules.js';
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
  assert.equal(cleanPayee('AMZN Mktp US*RT4G59DK3'), 'Amazon');
});

test('cleanPayee prefers Plaid merchant_name when present', () => {
  assert.equal(cleanPayee('SQ *GARBAGE STRING #99', 'Blue Bottle Coffee'), 'Blue Bottle Coffee');
});

test('cleanPayee is stable across formatting variants', () => {
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
  // Synthetic pre-storage fixtures have no Postgres transaction UUIDs yet.
  // The transfer relationship is still detected, but we must not put a Plaid
  // external id into the UUID foreign-key field.
  assert.equal(outflow.transfer_pair_id, null);
  assert.equal(inflow.transfer_pair_id, null);
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
  // Use database-shaped UUID ids here because transfer_pair_id is a FK to
  // transactions.id, not to Plaid's external transaction id.
  const txns = [
    { id: '11111111-1111-4111-8111-111111111111', plaid_transaction_id: 'a', account_id: 'chk', posted_date: '2026-07-05', amount: 500, payee: 'X', raw_description: '' },
    { id: '22222222-2222-4222-8222-222222222222', plaid_transaction_id: 'b', account_id: 'chk', posted_date: '2026-07-06', amount: 500, payee: 'X', raw_description: '' },
    { id: '33333333-3333-4333-8333-333333333333', plaid_transaction_id: 'c', account_id: 'crd', posted_date: '2026-07-05', amount: -500, payee: 'Y', raw_description: '' },
    { id: '44444444-4444-4444-8444-444444444444', plaid_transaction_id: 'd', account_id: 'crd', posted_date: '2026-07-06', amount: -500, payee: 'Y', raw_description: '' },
  ];
  const out = detectTransfers(txns);
  assert.ok(out.every((t) => t.is_transfer), 'all four should pair up');
  const links = new Set(out.map((t) => [t.id, t.transfer_pair_id].sort().join('-')));
  assert.equal(links.size, 2, 'exactly two distinct pairs');
  assert.ok(out.every((t) => txns.some((candidate) => candidate.id === t.transfer_pair_id)));
});

test('same-account opposite amounts are not a transfer', () => {
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
  assert.equal(
    inferCadence(['2026-07-03', '2026-07-17', '2026-07-31', '2026-08-14']),
    'biweekly',
  );
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
  assert.equal(semi.typical_amount, 1912.4);
  assert.ok(
    biweekly.typical_amount > 1900 && biweekly.typical_amount < 2500,
    `median ${biweekly.typical_amount} should sit mid-range`,
  );
});

test('cadence detection survives varying amounts', () => {
  const { streams } = runPipeline();
  const biweekly = streams.find((s) => s.cadence === 'biweekly');
  assert.equal(biweekly.occurrences, 8, 'all eight varying paychecks in one stream');
});

test('three-paycheck month is projected correctly', () => {
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
  const naive = txns
    .filter((t) => t.amount > 0 && !t.pending)
    .reduce((s, t) => s + t.amount, 0);
  const correct = totalSpending(txns);
  assert.equal(Number((naive - correct).toFixed(2)), 3992.53);
});

// ---------------------------------------------------------------------------
// Transfers Plaid names for us
// ---------------------------------------------------------------------------

test('money moved to a brokerage is a transfer, not spending', () => {
  const rows = detectTransfers([
    {
      plaid_transaction_id: 'inv1', account_id: 'a1', posted_date: '2026-08-03',
      amount: 500, payee: 'Fidelity', raw_description: 'FIDELITY INVESTMENTS',
      plaidCategory: { primary: 'TRANSFER_OUT', detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS' },
    },
  ]);
  assert.equal(rows[0].is_transfer, true);
  assert.equal(totalSpending(rows), 0);
});

test('a credit card payment is a transfer even when Plaid calls it a loan payment', () => {
  const rows = detectTransfers([
    {
      plaid_transaction_id: 'cc1', account_id: 'a1', posted_date: '2026-08-05',
      amount: 1450, payee: 'Chase', raw_description: 'CHASE CARD PMT',
      plaidCategory: { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' },
    },
  ]);
  assert.equal(rows[0].is_transfer, true);
});

test('a real loan payment is still spending', () => {
  const rows = detectTransfers([
    {
      plaid_transaction_id: 'car1', account_id: 'a1', posted_date: '2026-08-05',
      amount: 420, payee: 'Toyota Financial', raw_description: 'TOYOTA FINANCIAL AUTO',
      plaidCategory: { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CAR_PAYMENT' },
    },
  ]);
  assert.equal(rows[0].is_transfer, undefined);
  assert.equal(totalSpending(rows), 420);
});

test('a deposit Plaid calls a transfer is left alone, so income survives', () => {
  const rows = detectTransfers([
    {
      plaid_transaction_id: 'dep1', account_id: 'a1', posted_date: '2026-08-05',
      amount: -2400, payee: 'Northstar Payroll', raw_description: 'DIRECT DEP',
      plaidCategory: { primary: 'TRANSFER_IN', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER' },
    },
  ]);
  assert.notEqual(rows[0].is_transfer, true);
});

test('a loan payment no longer defaults every loan to a car payment', () => {
  assert.equal(PFC_PRIMARY_MAP.LOAN_PAYMENTS, undefined);
  assert.equal(PFC_DETAILED_MAP.LOAN_PAYMENTS_CAR_PAYMENT, 'Car Payment');
  assert.equal(PFC_DETAILED_MAP.LOAN_PAYMENTS_MORTGAGE_PAYMENT, 'Rent/Mortgage');
});

test("Plaid's category survives the round trip through the database", () => {
  const normalized = normalizePlaidTransaction({
    transaction_id: 't1', date: '2026-08-01', amount: 42, name: 'SOME SHOP',
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' },
  }, 'acct');

  assert.equal(normalized.pfc_primary, 'FOOD_AND_DRINK');
  assert.equal(normalized.pfc_detailed, 'FOOD_AND_DRINK_GROCERIES');

  const fromDb = { payee: 'SOME SHOP', pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: 'FOOD_AND_DRINK_GROCERIES' };
  assert.deepEqual(plaidCategoryOf(fromDb), { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' });

  const [decided] = categorizeBatch([{ ...fromDb, manually_categorized: false }], { learned: new Map() });
  assert.equal(decided.category, 'Groceries');
  assert.equal(decided.categorized_by, 'plaid_pfc');
});

test('a stored brokerage transfer is recognised after a reprocess, not just at insert', () => {
  const fromDb = {
    plaid_transaction_id: 'inv1', account_id: 'a1', posted_date: '2026-08-03',
    amount: 500, payee: 'Fidelity', raw_description: 'FIDELITY',
    pfc_primary: 'TRANSFER_OUT', pfc_detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS',
  };
  assert.equal(detectTransfers([fromDb])[0].is_transfer, true);
});
