/**
 * Full financial picture from synthetic fixtures.
 *
 * Runs every engine end to end and prints what the household would actually be
 * told. `npm run plan`
 */

import { readFileSync } from 'node:fs';
import { normalizePlaidTransaction, categorizeBatch } from '../src/engine/categorize.js';
import { detectTransfers } from '../src/engine/transfers.js';
import { detectIncomeStreams, markIncome } from '../src/engine/income.js';
import { modelIncomeStreams, reliableMonthlyIncome } from '../src/engine/variable-income.js';
import { buildExpensePicture, floorCoverage } from '../src/engine/expenses.js';
import { allocateSeries, findExtraPaycheckMonths } from '../src/engine/allocate.js';
import { buildGuidance, incomeStructureAdvice } from '../src/engine/guidance.js';
import { modelChildTransition } from '../src/engine/child-transition.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/sample-plaid.json', import.meta.url)));

let txns = fixture.transactions.map((t) => normalizePlaidTransaction(t, t.account_id));
txns = detectTransfers(txns);
let streams = detectIncomeStreams(txns);
txns = markIncome(txns, streams);
txns = categorizeBatch(txns, { learned: new Map() });
streams = modelIncomeStreams(streams, txns);

const income = reliableMonthlyIncome(streams);
const picture = buildExpensePicture(txns);
const coverage = floorCoverage(picture, income.reliable);

const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const head = (s) => console.log(`\n${'═'.repeat(74)}\n  ${s}\n${'═'.repeat(74)}`);
const sub = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 68 - s.length))}`);

// ---------------------------------------------------------------------------
head('1. WHERE THE MONEY GOES');

console.log(`\n  Based on ${picture.monthsAnalyzed} complete months of history.\n`);
console.log(`  Committed (must pay)      ${money(picture.monthly.committed).padStart(12)}`);
console.log(`  Necessary (groceries etc) ${money(picture.monthly.necessary).padStart(12)}`);
console.log(`  Discretionary             ${money(picture.monthly.discretionary).padStart(12)}`);
console.log(`  Irregular (amortized)     ${money(picture.monthly.irregular).padStart(12)}   ${money(picture.irregularAnnualTotal)}/yr`);
console.log(`  ${'─'.repeat(40)}`);
console.log(`  Survival cost             ${money(picture.survivalMonthlyCost).padStart(12)}   ← emergency fund sizes on this`);
console.log(`  True monthly cost         ${money(picture.trueMonthlyCost).padStart(12)}`);

sub('Largest commitments');
picture.categories.filter((c) => c.bucket === 'committed').slice(0, 5)
  .forEach((c) => console.log(`  ${c.category.padEnd(20)} ${money(c.monthlyAverage).padStart(11)}/mo`));

sub('Reclassified by spending pattern');
const reclassified = picture.categories.filter((c) => c.reclassified);
reclassified.length
  ? reclassified.slice(0, 4).forEach((c) =>
      console.log(`  ${c.category.padEnd(20)} appears ${c.monthsPresent}/${picture.monthsAnalyzed} months → amortized`))
  : console.log('  none');

// ---------------------------------------------------------------------------
head('2. WHAT YOU CAN COUNT ON');

for (const s of streams) {
  const d = s.distribution;
  sub(s.payee);
  console.log(`  ${d.stability.toUpperCase()} · ${s.cadence} · ${d.samples} paychecks observed`);
  if (d.stability === 'variable') {
    console.log(`  Range ${money(d.min)} – ${money(d.max)}   (varies ±${Math.round(d.variability * 100)}%)`);
    console.log(`  Floor ${money(d.floor)}  ·  Median ${money(d.median)}  ·  Upside ${money(d.upside)}/check`);
    console.log(`  → Bills planned against ${money(d.floor)}, not the median.`);
  } else {
    console.log(`  Every check ${money(d.median)} — no variance.`);
  }
}

sub('Household monthly');
console.log(`  Reliable (bad month)   ${money(income.reliable).padStart(12)}   ← what bills are planned against`);
console.log(`  Expected (typical)     ${money(income.expected).padStart(12)}`);
console.log(`  Upside                 ${money(income.upside).padStart(12)}   ← the money that becomes savings`);

sub(`Floor coverage: ${coverage.status.toUpperCase()}`);
console.log(`  ${coverage.message}`);
console.log(`\n  Surplus on a slow stretch: ${money(coverage.fullSurplus)}/mo`);

// ---------------------------------------------------------------------------
head('3. HOW MUCH TO PUT AWAY, PER PAYCHECK');

const variableStream = streams.find((s) => s.distribution.stability === 'variable');
const paychecks = txns
  .filter((t) => t.is_income && t.payee === variableStream.payee)
  .sort((a, b) => a.posted_date.localeCompare(b.posted_date))
  .map((t) => ({ amount: Math.abs(t.amount), date: t.posted_date, cadence: 'biweekly' }));

const commitments = picture.categories
  .filter((c) => c.bucket === 'committed')
  .map((c, i) => ({ category: c.category, amount: c.monthlyAverage, dueDay: [14, 12, 15, 16, 3, 8][i] ?? 1 }));

// This earner covers roughly the share of bills their income represents.
const share = income.detail.find((d) => d.payee === variableStream.payee).monthlyReliable / income.reliable;

const series = allocateSeries(paychecks, {
  commitments,
  irregularAnnualTotal: picture.irregularAnnualTotal,
  necessaryMonthly: picture.monthly.necessary,
  shareOfHousehold: share,
  openingBuffer: 0,
  nextPayday: '2026-08-28',
});

for (const a of series.allocations) {
  const tag = a.status === 'surplus' ? '' : `  [${a.status.toUpperCase()}]`;
  console.log(`\n  ${a.paycheckDate}  check ${money(a.paycheckAmount)}${tag}`);
  console.log(`     bills ${money(a.holdForBills)} · sinking ${money(a.moveToSinking)} · necessities ${money(a.keepForNecessary)}`);
  console.log(`     → ${a.status === 'surplus' ? `PUT AWAY ${money(a.surplus)}` : `SHORT ${money(a.shortfall)}, draw ${money(a.bufferDraw)}`}`);
}

sub('Across these paychecks');
console.log(`  Total put away        ${money(series.totalSaved).padStart(12)}`);
console.log(`  Drawn from buffer     ${money(series.totalDrawn).padStart(12)}`);
console.log(`  Net saved             ${money(series.netSaved).padStart(12)}`);
console.log(`  Checks needing buffer ${String(series.checksNeedingBuffer).padStart(12)} of ${paychecks.length}`);

const extra = findExtraPaycheckMonths(paychecks.map((p) => p.date));
if (extra.length) {
  sub('Three-paycheck months');
  extra.forEach((e) => console.log(`  ${e.month}: ${e.paychecks} checks — the extra one is almost entirely surplus`));
}

// ---------------------------------------------------------------------------
head('4. WHAT TO DO NEXT');

const structure = incomeStructureAdvice(streams, picture);
if (structure) {
  sub('Structure');
  console.log(`  ${structure.recommendation}`);
}

const guidance = buildGuidance({
  picture,
  coverage,
  monthlySurplus: coverage.fullSurplus,
  balances: { buffer: 0, emergency: 0 },
  debts: [
    { name: 'Visa Everyday', balance: 4820.0, apr: 24.99, minimumPayment: 145 },
    { name: 'Amex Blue', balance: 2310.0, apr: 19.24, minimumPayment: 70 },
  ],
  flags: { hasFullEmployerMatch: true, childPlannedWithinYears: 2 },
});

for (const step of guidance.steps) {
  const amount = step.amount ? `  ${money(step.amount)}` : '';
  const done = step.status === 'done' ? '  ✓' : '';
  console.log(`\n  ${step.priority}. ${step.title}${amount}${done}`);
  if (step.monthsToGoal) console.log(`     ~${step.monthsToGoal} months at current surplus`);
  console.log(`     ${step.why.replace(/\s+/g, ' ')}`);

  if (step.comparison) {
    const c = step.comparison;
    console.log(`\n     Avalanche: ${c.avalanche.months} months, ${money(c.avalanche.interestPaid)} interest  [${c.avalanche.order.join(' → ')}]`);
    console.log(`     Snowball:  ${c.snowball.months} months, ${money(c.snowball.interestPaid)} interest  [${c.snowball.order.join(' → ')}]`);
    console.log(`     Snowball costs ${money(c.interestDifference)} more. Your call.`);
  }
}

// ---------------------------------------------------------------------------
head('5. THE CHILD, ~2 YEARS OUT');

const child = modelChildTransition({
  picture,
  reliableMonthlyIncome: income.reliable,
  monthlySurplus: coverage.fullSurplus,
  leave: {
    weeks: 12,
    paidWeeks: 6,
    payReplacementRate: 0.6,
    normalMonthlyIncome: 3824.8,
    isStableEarner: true,
  },
  yearsAway: 2,
});

console.log(`\n  Childcare      ${money(child.childcare.monthly)}/mo  (${money(child.childcare.annual)}/yr)`);
if (child.childcare.versusRent) {
  const vs = child.childcare.monthly >= child.childcare.versusRent ? 'MORE than' : 'less than';
  console.log(`                 ${vs} your rent of ${money(child.childcare.versusRent)}`);
}
console.log(`  Birth cost     ${money(child.birth.cost)}   (deductible + out-of-pocket max)`);
console.log(`  Leave gap      ${money(child.leave.incomeLost)}   (${child.leave.weeks}wk leave, ${child.leave.paidWeeks}wk at ${child.leave.payReplacementRate * 100}%)`);
console.log(`  ${'─'.repeat(50)}`);
console.log(`  One-time need  ${money(child.oneTimeNeed)}`);
console.log(`  Set aside      ${money(child.monthlySetAside)}/mo for ${child.monthsToPrepare} months`);

sub('Monthly surplus, before and after');
console.log(`  Now:   ${money(child.surplus.now)}`);
console.log(`  After: ${money(child.surplus.after)}   (${child.surplus.reductionPercent}% absorbed by childcare)`);

for (const insight of child.insights) {
  sub(`[${insight.severity.toUpperCase()}] ${insight.title}`);
  console.log(`  ${insight.detail.replace(/\s+/g, ' ')}`);
}

sub('Need to find out');
child.unknowns.forEach((u) => console.log(`  • ${u.replace(/\s+/g, ' ')}`));

console.log(`\n${'─'.repeat(74)}`);
console.log(`  ${guidance.disclaimer.replace(/\s+/g, ' ')}`);
console.log();
