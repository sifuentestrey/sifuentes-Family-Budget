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

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

import { analyzeSubscriptions, detectPriceChange, classifyStream, negotiationCandidates, draftCancellation } from '../src/engine/subscriptions.js';
import { detectRecurringStreams } from '../src/engine/recurring.js';

const subs = () => analyzeSubscriptions(pipeline().txns);

test('rent and utilities are bills, not subscriptions', () => {
  // A "subscriptions" list topped by rent is useless for the one thing the
  // list exists for: deciding what to cancel.
  const a = subs();
  assert.ok(!a.subscriptions.some((s) => /rent/i.test(s.payee)), 'rent is not cancellable');
  assert.ok(a.bills.some((s) => /rent/i.test(s.payee)), 'rent belongs in bills');
  assert.ok(a.bills.some((s) => /pg&e|comcast/i.test(s.payee)));
});

test('frequent merchants are neither subscription nor bill', () => {
  const a = subs();
  const names = a.frequentMerchants.map((s) => s.payee).join(' ');
  assert.match(names, /Safeway/, 'shopping often is not a subscription');
  assert.ok(!a.subscriptions.some((s) => /safeway|shell/i.test(s.payee)));
  assert.ok(!a.bills.some((s) => /safeway|shell/i.test(s.payee)));
});

test('actual subscriptions are found with annual cost', () => {
  const a = subs();
  const netflix = a.subscriptions.find((s) => /netflix/i.test(s.payee));
  assert.ok(netflix);
  // Annualized on the CURRENT price, not the median, which lags after a rise.
  assert.equal(netflix.annualCost, round2(netflix.last_amount * 12));
  assert.ok(a.totalAnnual > 0 && a.totalAnnual < 5000, 'plausible subscription total');
});

test('a sustained price increase is detected', () => {
  const a = subs();
  const netflix = a.priceIncreases.find((s) => /netflix/i.test(s.payee));
  assert.ok(netflix, 'the increase that actually happened');
  assert.equal(netflix.priceChange.from, 15.99);
  assert.equal(netflix.priceChange.to, 17.99);
  assert.equal(netflix.annualImpactOfIncrease, 24);
});

test('variable-amount merchants never report price increases', () => {
  // Groceries varying 10-20% weekly is normal. Reporting it as a price rise
  // would bury the one alert that matters under noise.
  const a = subs();
  assert.ok(
    !a.priceIncreases.some((s) => /safeway|shell|chipotle/i.test(s.payee)),
    'natural fluctuation is not a price change',
  );
});

test('a single spike is not a price increase', () => {
  // One larger charge is usually a prorated month, not a new price.
  assert.equal(detectPriceChange([10, 10, 25, 10, 10]), null);
  // A change that holds is.
  const held = detectPriceChange([10, 10, 12, 12, 12]);
  assert.ok(held);
  assert.equal(held.to, 12);
});

test('duplicate services are raised as a question, not an instruction', () => {
  const a = subs();
  assert.ok(a.duplicates.length > 0, 'three entertainment services in the fixture');
  assert.match(a.duplicates[0].question, /\?$/, 'asked, not asserted — they may want both');
});

test('card autopay is never listed as a recurring charge', () => {
  // A credit card payment recurs monthly and is the household's largest
  // "charge". Listing it would put it at the top of every list.
  const { txns } = pipeline();
  const streams = detectRecurringStreams(txns, { direction: 'outflow' });
  assert.ok(!streams.some((s) => /chase credit|autopay|amex epayment/i.test(s.payee)));
});

test('paychecks never appear as recurring charges', () => {
  const { txns } = pipeline();
  const streams = detectRecurringStreams(txns, { direction: 'outflow' });
  assert.ok(!streams.some((s) => /payroll|dirdep/i.test(s.payee)));
});

test('classifyStream separates the three kinds', () => {
  assert.equal(classifyStream('Subscriptions'), 'subscription');
  assert.equal(classifyStream('Rent/Mortgage'), 'bill');
  assert.equal(classifyStream('Groceries'), 'merchant');
  assert.equal(classifyStream(null), 'merchant');
});

test('cancellation draft is written for the user to send themselves', () => {
  const a = subs();
  const draft = draftCancellation(a.subscriptions[0]);
  assert.ok(draft.subject && draft.body);
  assert.match(draft.note, /You send this/, 'honest about not being a concierge');
  assert.match(draft.body, /retention offer/);
});

test('negotiation candidates come with a script', () => {
  const a = subs();
  const candidates = negotiationCandidates([...a.subscriptions, ...a.bills]);
  const comcast = candidates.find((c) => /comcast/i.test(c.payee));
  assert.ok(comcast, 'internet is negotiable');
  assert.ok(comcast.script.length > 3);
  assert.ok(comcast.script.some((line) => /retention/i.test(line)));
});

function round2(n) {
  return Number(n.toFixed(2));
}

// ---------------------------------------------------------------------------
// Forecast, net worth, alerts
// ---------------------------------------------------------------------------

import { projectBalance, calculateNetWorth } from '../src/engine/forecast.js';
import { buildAlerts, composeAlertEmail } from '../src/engine/alerts.js';

test('forecast projects the floor case, not the average', () => {
  const { streams } = pipeline();
  const floor = projectBalance({
    openingBalance: 2000, startDate: '2026-08-15', days: 30,
    incomeStreams: streams, bills: [{ payee: 'Rent', amount: 2350, dueDay: 14 }],
    dailyNecessary: 15, basis: 'floor',
  });
  const median = projectBalance({
    openingBalance: 2000, startDate: '2026-08-15', days: 30,
    incomeStreams: streams, bills: [{ payee: 'Rent', amount: 2350, dueDay: 14 }],
    dailyNecessary: 15, basis: 'median',
  });
  // Forecasting on typical pay says "you'll be fine" in exactly the periods
  // where the household won't be — removing the warning that matters.
  assert.ok(floor.lowestPoint.balance <= median.lowestPoint.balance);
});

test('forecast identifies the low point and its date', () => {
  const result = projectBalance({
    openingBalance: 500, startDate: '2026-08-01', days: 20,
    incomeStreams: [], bills: [{ payee: 'Rent', amount: 2350, dueDay: 14 }],
    dailyNecessary: 10,
  });
  assert.ok(result.goesNegative);
  assert.equal(result.lowestPoint.date, '2026-08-21');
  assert.equal(result.safeToSpendToday, 0, 'nothing is safe to spend when heading negative');
});

test('net worth subtracts card and loan balances', () => {
  const result = calculateNetWorth([
    { nickname: 'Checking', type: 'checking', current_balance: 5000 },
    { nickname: 'Savings', type: 'savings', current_balance: 12000 },
    { nickname: 'Visa', type: 'credit', current_balance: -4820 },
    { nickname: 'Car Loan', type: 'loan', current_balance: -9000 },
  ]);
  assert.equal(result.totalAssets, 17000);
  assert.equal(result.totalLiabilities, 13820);
  assert.equal(result.netWorth, 3180);
});

test('absent investments are stated, never rendered as zero', () => {
  const result = calculateNetWorth([{ nickname: 'Checking', type: 'checking', current_balance: 100 }]);
  assert.equal(result.investmentsConnected, false);
  assert.match(result.note, /not connected/);
  assert.match(result.note, /not your total net worth/);
});

test('low balance produces an urgent alert', () => {
  const { alerts, toEmail } = buildAlerts({
    forecast: {
      lowestBeforeNextPayday: { balance: -140, date: '2026-08-21' },
      lowestPoint: { balance: -140, date: '2026-08-21' },
    },
  });
  const low = alerts.find((a) => a.type === 'low_balance');
  assert.ok(low);
  assert.ok(low.urgent);
  assert.match(low.title, /negative/i);
  assert.ok(toEmail.includes(low), 'urgent alerts email');
});

function isoDaysFromNow(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test('an overdue bill produces an urgent, separately-keyed alert from a due-soon one', () => {
  const { alerts } = buildAlerts({
    bills: [
      { id: 'bill_overdue', providerName: 'Example Power', amountDue: 203.17, dueDate: isoDaysFromNow(-2), status: 'detected' },
      { id: 'bill_soon', providerName: 'Example Water', amountDue: 74.2, dueDate: isoDaysFromNow(2), status: 'confirmed' },
    ],
  });

  const overdue = alerts.find((a) => a.type === 'bill_overdue');
  const soon = alerts.find((a) => a.type === 'bill_due_soon');
  assert.ok(overdue, 'overdue bill produces an alert');
  assert.ok(overdue.urgent);
  assert.equal(overdue.key, 'bill_overdue:bill_overdue');
  assert.ok(soon, 'a bill due within the window produces an alert');
  assert.equal(soon.key, 'bill_due_soon:bill_soon');
  assert.notEqual(overdue.key, soon.key, 'overdue and due-soon use different keys so dismissing one does not silence the other');
});

test('a bill due further out than the window produces no alert', () => {
  const { alerts } = buildAlerts({
    bills: [{ id: 'bill_far', providerName: 'Example Insurance', amountDue: 1428, dueDate: isoDaysFromNow(30), status: 'detected' }],
  });
  assert.equal(alerts.filter((a) => a.type.startsWith('bill_')).length, 0);
});

test('paid, ignored, and needs-review bills never alert', () => {
  const { alerts } = buildAlerts({
    bills: [
      { id: 'b1', providerName: 'P', amountDue: 10, dueDate: isoDaysFromNow(-5), status: 'paid' },
      { id: 'b2', providerName: 'P', amountDue: 10, dueDate: isoDaysFromNow(-5), status: 'ignored' },
      { id: 'b3', providerName: 'P', amountDue: 10, dueDate: isoDaysFromNow(-5), status: 'detected', needsReview: true },
    ],
  });
  assert.equal(alerts.filter((a) => a.type.startsWith('bill_')).length, 0, 'nothing budgeted-against or unreviewed should alert');
});

test('an overdue bill alert reaches email', () => {
  const { toEmail } = buildAlerts({
    bills: [{ id: 'bill_overdue', providerName: 'Example Power', amountDue: 203.17, dueDate: isoDaysFromNow(-1), status: 'detected' }],
  });
  assert.ok(toEmail.some((a) => a.type === 'bill_overdue'));
});

test('dismissed alerts do not come back on the next sync', () => {
  const state = {
    forecast: {
      lowestBeforeNextPayday: { balance: -140, date: '2026-08-21' },
      lowestPoint: { balance: -140, date: '2026-08-21' },
    },
  };
  const first = buildAlerts(state);
  const key = first.alerts[0].key;
  const second = buildAlerts({ ...state, dismissed: new Set([key]) });
  assert.equal(second.alerts.length, 0, 'an alert that returns nightly gets the sender muted');
});

test('large-transaction detection is per category, not global', () => {
  // A $300 grocery run is unremarkable; a $300 coffee charge is not.
  const history = (category, amounts, extra = {}) =>
    amounts.map((amount, i) => ({
      plaid_transaction_id: `${category}_${i}`, category, amount,
      payee: category, posted_date: '2026-01-01', ...extra,
    }));

  const today = new Date().toISOString().slice(0, 10);
  const { alerts } = buildAlerts({
    transactions: [
      ...history('Groceries', [140, 150, 130, 145]),
      ...history('Coffee', [6, 7, 5, 6]),
      { plaid_transaction_id: 'big_coffee', category: 'Coffee', amount: 90, payee: 'Cafe', posted_date: today },
      { plaid_transaction_id: 'normal_groceries', category: 'Groceries', amount: 160, payee: 'Safeway', posted_date: today },
    ],
  });

  const large = alerts.filter((a) => a.type === 'large_transaction');
  assert.equal(large.length, 1);
  assert.match(large[0].title, /Coffee/);
});

test('only urgent alerts are emailed', () => {
  const { toEmail, inApp } = buildAlerts({
    subscriptions: {
      priceIncreases: [{
        payee: 'Netflix', annualImpactOfIncrease: 24,
        priceChange: { from: 15.99, to: 17.99, changePercent: 12.5 },
      }],
      duplicates: [{ category: 'Subscriptions', services: [{ payee: 'A' }, { payee: 'B' }], combinedAnnual: 300 }],
      lowConfidence: [],
    },
  });
  assert.ok(inApp.length > toEmail.length, 'non-urgent stays in-app');
  assert.ok(toEmail.every((a) => a.urgent));
});

test('no email is composed when nothing is urgent', () => {
  assert.equal(composeAlertEmail([{ urgent: false, title: 'x', body: 'y' }]), null);
});

test('a partial trailing month does not make every month look extra', () => {
  // History ends mid-August with one check so far. Using the minimum count as
  // the baseline would flag May, June AND July as three-paycheck months.
  const paydays = [
    '2026-05-08', '2026-05-22',
    '2026-06-05', '2026-06-19',
    '2026-07-03', '2026-07-17', '2026-07-31',
    '2026-08-14',
  ];
  const extra = findExtraPaycheckMonths(paydays);
  assert.equal(extra.length, 1, 'only July genuinely has a third check');
  assert.equal(extra[0].month, '2026-07');
  assert.equal(extra[0].extraChecks, 1);
});
