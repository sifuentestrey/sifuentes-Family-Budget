/**
 * Variable income, expense picture, allocation, guidance, and child transition.
 * All offline against synthetic fixtures.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalizePlaidTransaction, categorizeBatch } from '../src/engine/categorize.js';
import { detectTransfers } from '../src/engine/transfers.js';
import { detectIncomeStreams, markIncome } from '../src/engine/income.js';
import {
  modelIncomeStreams, reliableMonthlyIncome, analyzeAmounts, percentile,
} from '../src/engine/variable-income.js';
import { buildExpensePicture, floorCoverage, bucketFor } from '../src/engine/expenses.js';
import { allocatePaycheck, allocateSeries, findExtraPaycheckMonths } from '../src/engine/allocate.js';
import { buildGuidance, bufferTarget, compareDebtStrategies, incomeStructureAdvice } from '../src/engine/guidance.js';
import { modelChildTransition, modelLeaveGap } from '../src/engine/child-transition.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/sample-plaid.json', import.meta.url)));

function pipeline() {
  let txns = fixture.transactions.map((t) => normalizePlaidTransaction(t, t.account_id));
  txns = detectTransfers(txns);
  let streams = detectIncomeStreams(txns);
  txns = markIncome(txns, streams);
  txns = categorizeBatch(txns, { learned: new Map() });
  streams = modelIncomeStreams(streams, txns);
  const picture = buildExpensePicture(txns);
  const income = reliableMonthlyIncome(streams);
  return { txns, streams, picture, income, coverage: floorCoverage(picture, income.reliable) };
}

// ---------------------------------------------------------------------------
// Variable income
// ---------------------------------------------------------------------------

test('percentile interpolates rather than snapping to observations', () => {
  const values = [100, 200, 300, 400, 500];
  assert.equal(percentile(values, 50), 300);
  // p20 of 5 samples sits between the 1st and 2nd — interpolated, so the floor
  // moves smoothly as history accrues instead of jumping between checks.
  assert.equal(percentile(values, 20), 180);
});

test('stable and variable earners are classified differently in one household', () => {
  const { streams } = pipeline();
  const variable = streams.find((s) => s.distribution.stability === 'variable');
  const stable = streams.find((s) => s.distribution.stability === 'stable');

  assert.ok(variable, 'call-shift earner classified variable');
  assert.ok(stable, 'salaried spouse classified stable');
  assert.ok(variable.distribution.variability > 0.15);
  assert.equal(stable.distribution.variability, 0);
});

test('floor sits below median and above the worst check', () => {
  const { streams } = pipeline();
  const d = streams.find((s) => s.distribution.stability === 'variable').distribution;
  assert.ok(d.floor < d.median, 'floor must be conservative');
  assert.ok(d.floor > d.min, 'floor should not be the single worst observation');
  assert.equal(d.upside, Number((d.median - d.floor).toFixed(2)));
});

test('too few samples yields unknown, not a confident stable classification', () => {
  // Claiming stability from 3 points would produce an unearned floor.
  const result = analyzeAmounts([2000, 2000, 2000]);
  assert.equal(result.stability, 'unknown');
});

test('reliable income uses the floor for variable and median for stable', () => {
  const { streams, income } = pipeline();
  const variable = streams.find((s) => s.distribution.stability === 'variable');

  const detail = income.detail.find((d) => d.payee === variable.payee);
  assert.equal(detail.basis, 'floor (p20)');
  assert.equal(detail.perCheck, variable.distribution.floor);

  assert.ok(income.reliable < income.expected, 'reliable must be conservative');
  assert.ok(income.upside > 0, 'upside is the money the plan converts to savings');
});

test('biweekly is 26 checks a year, not 24', () => {
  // Rounding biweekly to 2/month loses two checks annually — precisely the
  // three-paycheck months.
  const { income, streams } = pipeline();
  const variable = streams.find((s) => s.cadence === 'biweekly');
  const detail = income.detail.find((d) => d.payee === variable.payee);
  const impliedRate = detail.monthlyReliable / detail.perCheck;
  assert.ok(Math.abs(impliedRate - 26 / 12) < 0.01, `rate ${impliedRate} should be 26/12`);
});

// ---------------------------------------------------------------------------
// Expense picture
// ---------------------------------------------------------------------------

test('survival cost excludes discretionary and is below true cost', () => {
  const { picture } = pipeline();
  assert.ok(picture.survivalMonthlyCost < picture.trueMonthlyCost);
  assert.equal(
    picture.survivalMonthlyCost,
    Number((picture.monthly.committed + picture.monthly.necessary + picture.monthly.irregular).toFixed(2)),
  );
});

test('groceries and gas are necessary, not discretionary', () => {
  const { picture } = pipeline();
  for (const name of ['Groceries', 'Gas']) {
    const category = picture.categories.find((c) => c.category === name);
    assert.equal(category.bucket, 'necessary', `${name} must not be treated as optional`);
  }
});

test('an annual premium is reclassified as irregular despite a fixed label', () => {
  // Car Insurance is labelled 'fixed' in the taxonomy because most people pay
  // monthly. Paid annually, treating it as a fixed monthly cost is wrong in
  // both directions at once.
  const { picture } = pipeline();
  const insurance = picture.categories.find((c) => c.category === 'Car Insurance');
  assert.equal(insurance.bucket, 'irregular');
  assert.ok(insurance.reclassified, 'pattern should override the declared kind');
});

test('irregular costs are amortized, never medianed to zero', () => {
  const { picture } = pipeline();
  assert.ok(picture.monthly.irregular > 0, 'a median across empty months would report zero');
  assert.ok(picture.irregularAnnualTotal > 0);
});

test('recurring monthly categories are not mistaken for irregular', () => {
  const { picture } = pipeline();
  const rent = picture.categories.find((c) => c.category === 'Rent/Mortgage');
  assert.equal(rent.bucket, 'committed');
  assert.equal(rent.monthlyAverage, 2350);
});

test('floor coverage reports a deficit honestly', () => {
  const { picture } = pipeline();
  // Income well below necessities must not produce an encouraging number.
  const broke = floorCoverage(picture, picture.survivalMonthlyCost - 1500);
  assert.equal(broke.status, 'deficit');
  assert.ok(broke.survivalSurplus < 0);
  assert.match(broke.message, /not meaningful/);
});

// ---------------------------------------------------------------------------
// Allocation — the core ask
// ---------------------------------------------------------------------------

const allocationCtx = {
  commitments: [
    { category: 'Rent/Mortgage', amount: 2350, dueDay: 14 },
    { category: 'Childcare', amount: 1240, dueDay: 12 },
  ],
  irregularAnnualTotal: 5791.42,
  necessaryMonthly: 448.34,
  shareOfHousehold: 0.5,
  nextPayday: '2026-08-28',
};

test('surplus tracks paycheck size, not the calendar', () => {
  // The bug this guards: funding bills by due date made the SMALLEST check of
  // the month report the LARGEST surplus, because rent happened to fall in the
  // other window. That inverts the guidance and teaches overspending on light
  // checks.
  const big = allocatePaycheck(
    { amount: 3104.67, date: '2026-07-03', cadence: 'biweekly' },
    { ...allocationCtx, nextPayday: '2026-07-17' },
  );
  const small = allocatePaycheck(
    { amount: 1412.88, date: '2026-05-22', cadence: 'biweekly' },
    { ...allocationCtx, nextPayday: '2026-06-05' },
  );

  assert.ok(big.surplus > small.surplus, 'a bigger check must yield a bigger surplus');
  assert.equal(big.holdForBills, small.holdForBills, 'bill funding is levelled across checks');
});

test('a shortfall is named, never softened into a small positive', () => {
  const result = allocatePaycheck(
    { amount: 400, date: '2026-05-22', cadence: 'biweekly' },
    { ...allocationCtx, nextPayday: '2026-06-05', bufferBalance: 0 },
  );
  assert.equal(result.status, 'shortfall');
  assert.equal(result.surplus, 0);
  assert.ok(result.shortfall > 0);
  assert.match(result.message, /short/);
});

test('buffer covering a light check is framed as the plan working', () => {
  const result = allocatePaycheck(
    { amount: 400, date: '2026-05-22', cadence: 'biweekly' },
    { ...allocationCtx, nextPayday: '2026-06-05', bufferBalance: 5000 },
  );
  assert.equal(result.status, 'buffer_covers');
  assert.ok(result.bufferDraw > 0);
  assert.match(result.message, /what it's for|working/);
});

test('sinking contribution funds the annual total across a year', () => {
  const result = allocatePaycheck(
    { amount: 2000, date: '2026-05-08', cadence: 'biweekly' },
    { ...allocationCtx, shareOfHousehold: 1, nextPayday: '2026-05-22' },
  );
  // 26 biweekly checks must sum to the annual irregular total.
  assert.ok(Math.abs(result.moveToSinking * 26 - allocationCtx.irregularAnnualTotal) < 1);
});

test('buffer carries forward across a series', () => {
  const checks = [
    { amount: 3000, date: '2026-05-08', cadence: 'biweekly' },
    { amount: 3000, date: '2026-05-22', cadence: 'biweekly' },
    { amount: 300, date: '2026-06-05', cadence: 'biweekly' },
  ];
  const series = allocateSeries(checks, { ...allocationCtx, openingBuffer: 0 });
  assert.ok(series.allocations[0].bufferAfter > 0);
  // The light check draws on what the earlier ones built.
  assert.equal(series.checksNeedingBuffer, 1);
  assert.ok(series.allocations[2].bufferDraw > 0);
});

test('three-paycheck months are identified', () => {
  const paydays = [
    '2026-07-03', '2026-07-17', '2026-07-31',
    '2026-08-14', '2026-08-28',
  ];
  const extra = findExtraPaycheckMonths(paydays);
  assert.equal(extra.length, 1);
  assert.equal(extra[0].month, '2026-07');
  assert.equal(extra[0].paychecks, 3);
});

// ---------------------------------------------------------------------------
// Guidance
// ---------------------------------------------------------------------------

const guidanceState = (overrides = {}) => {
  const { picture, coverage } = pipeline();
  return {
    picture,
    coverage,
    monthlySurplus: coverage.fullSurplus,
    balances: { buffer: 0, emergency: 0 },
    debts: [
      { name: 'Visa', balance: 4820, apr: 24.99, minimumPayment: 145 },
      { name: 'Amex', balance: 2310, apr: 19.24, minimumPayment: 70 },
    ],
    flags: { hasFullEmployerMatch: true, childPlannedWithinYears: 2 },
    ...overrides,
  };
};

test('a captured employer match is asserted, not recommended', () => {
  const { steps } = buildGuidance(guidanceState());
  const match = steps.find((s) => s.key === 'employer_match');
  assert.equal(match.status, 'done');
  assert.equal(match.amount, 0);
});

test('an uncaptured match outranks debt', () => {
  const { steps } = buildGuidance(
    guidanceState({ flags: { hasFullEmployerMatch: false, childPlannedWithinYears: 2 } }),
  );
  const match = steps.findIndex((s) => s.key === 'employer_match');
  const debt = steps.findIndex((s) => s.key === 'high_interest_debt');
  assert.ok(match < debt, 'a 50-100% instant return beats a 25% APR');
});

test('emergency fund sizes on survival cost, not total spending', () => {
  const state = guidanceState();
  const { steps } = buildGuidance(state);
  const fund = steps.find((s) => s.key === 'emergency_fund');
  assert.equal(fund.target, Number((state.picture.survivalMonthlyCost * 4).toFixed(2)));
  assert.ok(
    fund.target < state.picture.trueMonthlyCost * 4,
    'using total spending would inflate the target',
  );
});

test('a structural deficit blocks everything else', () => {
  const state = guidanceState();
  const deficit = floorCoverage(state.picture, state.picture.survivalMonthlyCost - 2000);
  const { steps } = buildGuidance({ ...state, coverage: deficit });
  assert.equal(steps[0].key, 'close_deficit');
  assert.ok(steps[0].blocking);
});

test('avalanche costs less interest when the orders genuinely differ', () => {
  // The strategies only diverge when the smallest balance is NOT the highest
  // rate. If they coincide, both produce the same order and the same cost —
  // which is a real outcome, just not one that tests anything.
  const comparison = compareDebtStrategies(
    [
      { name: 'Small low rate', balance: 1200, apr: 8, minimumPayment: 40 },
      { name: 'Big high rate', balance: 9000, apr: 27, minimumPayment: 150 },
    ],
    200,
  );

  assert.equal(comparison.avalanche.order[0], 'Big high rate', 'avalanche targets the rate');
  assert.equal(comparison.snowball.order[0], 'Small low rate', 'snowball targets the balance');
  assert.ok(comparison.avalanche.interestPaid < comparison.snowball.interestPaid);
  assert.ok(comparison.interestDifference > 0, 'the cost of choosing snowball is quantified');
});

test('identical orders produce identical cost, not a fabricated difference', () => {
  // When the smallest balance is also the highest rate, the two strategies are
  // the same plan. Reporting a difference here would be inventing one.
  const comparison = compareDebtStrategies(
    [
      { name: 'Big low rate', balance: 9000, apr: 8, minimumPayment: 150 },
      { name: 'Small high rate', balance: 1200, apr: 27, minimumPayment: 40 },
    ],
    200,
  );
  assert.deepEqual(comparison.avalanche.order, comparison.snowball.order);
  assert.equal(comparison.interestDifference, 0);
});

test('buffer target derives from this household\'s own income swing', () => {
  const tight = bufferTarget({ survivalMonthlyCost: 5000, reliableMonthlyIncome: 4000, committedMonthly: 3000 });
  const comfortable = bufferTarget({ survivalMonthlyCost: 5000, reliableMonthlyIncome: 8000, committedMonthly: 3000 });
  assert.equal(tight, 3000, 'gap of 1000 x 3 months');
  assert.equal(comfortable, 3000, 'floored at one month of committed costs');
  assert.ok(tight >= comfortable);
});

test('structure advice names the stable earner as the anchor', () => {
  const { streams, picture } = pipeline();
  const advice = incomeStructureAdvice(streams, picture);
  assert.ok(advice, 'mixed-stability household gets structural advice');
  assert.equal(advice.stability, undefined);
  assert.ok(advice.stableEarner && advice.variableEarner);
  assert.notEqual(advice.stableEarner, advice.variableEarner);
});

// ---------------------------------------------------------------------------
// Child transition
// ---------------------------------------------------------------------------

test('leave gap counts income lost, not just weeks off', () => {
  const gap = modelLeaveGap({
    weeks: 12, paidWeeks: 6, payReplacementRate: 0.6,
    normalMonthlyIncome: 4000, isStableEarner: true,
  });
  const weekly = (4000 * 12) / 52;
  assert.equal(gap.unpaidWeeks, 6);
  assert.equal(gap.incomeLost, Number((12 * weekly - 6 * weekly * 0.6).toFixed(2)));
  assert.ok(gap.warning, 'losing the stable earner is called out specifically');
});

test('losing the stable earner to leave is flagged high severity', () => {
  const { picture, coverage } = pipeline();
  const model = modelChildTransition({
    picture,
    reliableMonthlyIncome: 7647,
    monthlySurplus: coverage.fullSurplus,
    leave: { weeks: 12, paidWeeks: 6, payReplacementRate: 0.6, normalMonthlyIncome: 3824.8, isStableEarner: true },
  });
  const flagged = model.insights.find((i) => i.severity === 'high');
  assert.ok(flagged, 'the anchor disappearing is the sharpest risk');
  assert.match(flagged.title, /anchor/i);
});

test('childcare absorbing surplus is quantified, showing the closing window', () => {
  const { picture, coverage } = pipeline();
  const model = modelChildTransition({
    picture,
    reliableMonthlyIncome: 7647,
    monthlySurplus: coverage.fullSurplus,
    childcareMonthly: 1800,
  });
  assert.ok(model.surplus.after < model.surplus.now);
  assert.ok(model.surplus.reductionPercent > 0);
  assert.equal(model.surplus.after, Number((model.surplus.now - 1800).toFixed(2)));
});

test('unknown inputs are listed rather than guessed', () => {
  const { picture } = pipeline();
  const model = modelChildTransition({ picture, reliableMonthlyIncome: 7647, monthlySurplus: 2000 });
  assert.ok(model.unknowns.length > 0);
  assert.ok(model.unknowns.some((u) => /leave/i.test(u)), 'leave policy cannot be inferred from transactions');
  assert.equal(model.childcare.known, false);
  assert.ok(model.childcare.range, 'a range is shown instead of a false precision');
});
