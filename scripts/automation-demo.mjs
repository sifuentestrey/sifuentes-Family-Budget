/**
 * Run the bill + payroll pipelines against MOCK providers and print the result.
 *
 * Everything here is fixture data. No mail server, no timekeeping system, and
 * no bank is contacted. `npm run automation`
 */

import { createMockEmailProvider } from '../src/providers/mock/mock-email-provider.js';
import { createMockPayrollProvider } from '../src/providers/mock/mock-payroll-provider.js';
import { createRegistry } from '../src/providers/registry.js';
import { ingestBillsFromEmail } from '../src/ingestion/email-ingestion.js';
import { syncBills, syncPayroll, syncPaystubs, createMemoryStore, summarizeSyncState } from '../src/sync/sync-engine.js';
import { makePayProfile } from '../src/domain/payroll.js';
import { calculatePay } from '../src/payroll/pay-calculator.js';
import { forecastPaycheck, nextPayPeriod } from '../src/payroll/forecast.js';
import { reconcilePaycheck, learnFromHistory } from '../src/payroll/reconcile.js';
import { calculateSafeToSpend, monthlyOverview } from '../src/budget/safe-to-spend.js';

const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const head = (s) => console.log(`\n${'═'.repeat(72)}\n  ${s}\n${'═'.repeat(72)}`);
const sub = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 66 - s.length))}`);

const HOUSEHOLD = 'demo-household';
const store = createMemoryStore();

const registry = createRegistry();
const email = registry.register(createMockEmailProvider());
const payroll = registry.register(createMockPayrollProvider({ householdId: HOUSEHOLD }));

head('0. WHAT IS ACTUALLY CONNECTED');
const status = await registry.status();
for (const p of status) {
  const label = p.isLive ? 'LIVE' : 'MOCK — fixtures, nothing is connected';
  console.log(`  ${p.displayName.padEnd(30)} ${p.kind.padEnd(9)} ${label}`);
}
console.log(`\n  Live providers: ${status.filter((p) => p.isLive).length}. ` +
  'Everything below is synthetic and must never be shown to a user as real.');

// ---------------------------------------------------------------------------
head('1. BILL INGESTION');

const ingest = await ingestBillsFromEmail(email, { householdId: HOUSEHOLD });

console.log(`\n  Scanned ${ingest.messagesScanned} messages, ${ingest.messagesClassifiedAsBills} looked like bills.`);

sub('Bills detected');
for (const b of [...ingest.billsAccepted, ...ingest.needsReview]) {
  const flag = ingest.needsReview.includes(b) ? '  ← needs review' : '';
  console.log(`  ${b.providerName.padEnd(26)} ${money(b.amountDue).padStart(10)}  due ${b.dueDate}  ` +
    `${b.category.padEnd(16)} conf ${b.confidence}${flag}`);
}

sub('Rejected');
for (const s of ingest.skipped) console.log(`  ${s.subject ?? s.messageId}: ${s.reason}`);
for (const d of ingest.duplicates) {
  console.log(`  DUPLICATE ${d.candidate.providerName} — ${d.reason} (${d.matchType})`);
}

// ---------------------------------------------------------------------------
head('2. SYNC ENGINE');

const billRun = await syncBills({ provider: email, store, householdId: HOUSEHOLD, emailIngester: ingestBillsFromEmail });
const secondRun = await syncBills({ provider: email, store, householdId: HOUSEHOLD, emailIngester: ingestBillsFromEmail });

console.log(`\n  First run:  found ${billRun.itemsFound}, created ${billRun.itemsCreated}, duplicates ${billRun.duplicatesDetected}`);
console.log(`  Second run: found ${secondRun.itemsFound}, created ${secondRun.itemsCreated}, duplicates ${secondRun.duplicatesDetected}`);
console.log('  A re-sync creates nothing — the point of duplicate detection.');

const period = { start: '2026-07-20', end: '2026-08-02' };
const payrollRun = await syncPayroll({ provider: payroll, store, householdId: HOUSEHOLD, period });
const stubRun = await syncPaystubs({ provider: payroll, store, householdId: HOUSEHOLD });
console.log(`\n  Timecard: ${payrollRun.itemsCreated} entries. Paystubs: ${stubRun.itemsCreated}.`);

sub('Sync status');
for (const p of summarizeSyncState(store.runs).providers) {
  console.log(`  ${p.provider.padEnd(16)} ${p.kind.padEnd(10)} ${p.status.padEnd(8)} ${p.relative}` +
    `${p.isLive ? '' : '   (mock)'}`);
}

// ---------------------------------------------------------------------------
head('3. PAYCHECK FORECAST');

const profile = makePayProfile({
  householdId: HOUSEHOLD,
  label: 'Demo — 4x10 with call',
  baseHourlyRate: 42.5,
  dailyOvertimeThreshold: 0,   // 4x10: daily OT disabled
  weeklyOvertimeThreshold: 40,
  standbyRate: 3.5,
  callbackMinimumHours: 2,
  callbackMultiplier: 1.5,
  holidayMultiplier: 1.5,
  differentialRates: { night: 2.25 },
  recurringDeductions: [
    { label: 'Medical', amount: 142.21, preTax: true },
    { label: 'Union Dues', amount: 50 },
  ],
  taxAssumptions: { federalRate: 0.12, stateRate: 0.05, socialSecurityRate: 0.062, medicareRate: 0.0145 },
  payFrequency: 'biweekly',
  payPeriodStart: '2026-07-20',
  payPeriodEnd: '2026-08-02',
  payday: '2026-08-07',
});

const entries = store.timeEntries;
const breakdown = calculatePay(entries, profile);
const forecast = forecastPaycheck({ profile, entries, period, payDate: '2026-08-07', asOf: '2026-08-03' });

console.log(`\n  Next payday: ${forecast.payDate}`);
console.log(`  Period: ${period.start} to ${period.end}\n`);
const line = (label, hours, amount) =>
  console.log(`  ${label.padEnd(16)} ${String(hours).padStart(7)}h ${money(amount).padStart(12)}`);

line('Regular', breakdown.regularHours, breakdown.regularGross);
if (breakdown.overtimeHours) line('Overtime', breakdown.overtimeHours, breakdown.overtimeGross);
if (breakdown.callbackPaidHours) line('Callback', breakdown.callbackPaidHours, breakdown.callbackGross);
if (breakdown.standbyUnits) line('Standby', breakdown.standbyUnits, breakdown.standbyGross);
if (breakdown.holidayHours) line('Holiday', breakdown.holidayHours, breakdown.holidayGross);
if (breakdown.ptoHours) line('PTO', breakdown.ptoHours, breakdown.ptoGross);
if (breakdown.differentialGross) line('Differential', breakdown.differentialHours, breakdown.differentialGross);
console.log(`  ${'─'.repeat(38)}`);
console.log(`  ${'Gross'.padEnd(16)} ${''.padStart(8)} ${money(breakdown.totalGross).padStart(12)}`);
console.log(`  ${'Taxes'.padEnd(16)} ${''.padStart(8)} ${('-' + money(breakdown.totalTaxes)).padStart(12)}`);
console.log(`  ${'Deductions'.padEnd(16)} ${''.padStart(8)} ${('-' + money(breakdown.totalDeductions)).padStart(12)}`);
console.log(`  ${'TAKE-HOME'.padEnd(16)} ${''.padStart(8)} ${money(breakdown.estimatedNet).padStart(12)}`);
console.log(`\n  Confidence: ${forecast.confidence.toUpperCase()} (${forecast.confidenceScore})`);
for (const reason of forecast.confidenceReasons) console.log(`    • ${reason}`);

sub('How the schedule was handled');
for (const note of breakdown.notes) console.log(`  • ${note}`);

// ---------------------------------------------------------------------------
head('4. EXPECTED VS ACTUAL');

// Reconcile the forecast we just built against a paystub for the SAME period.
// Comparing a forecast to a stub from a different period yields expected $0 and
// a meaningless variance — the mismatch the learning guard now refuses to
// learn from.
const actualStub = {
  id: 'demo_stub',
  payDate: forecast.payDate,
  period,
  // What actually landed: gross close to forecast, but withholding higher than
  // the profile assumed and a deduction nobody had configured.
  grossPay: breakdown.totalGross,
  netPay: Math.round((breakdown.totalGross - breakdown.totalTaxes * 1.18 - 267.21) * 100) / 100,
  totalTaxes: Math.round(breakdown.totalTaxes * 1.18 * 100) / 100,
  deductions: [
    { label: 'Medical', amount: 142.21, preTax: true },
    { label: 'Union Dues', amount: 50 },
    { label: 'Garnishment', amount: 75 },
  ],
};

const reconciliation = reconcilePaycheck(forecast, actualStub);
console.log(`\n  Paystub ${actualStub.payDate}\n`);
for (const key of ['gross', 'net', 'taxes', 'deductions']) {
  const line = reconciliation[key];
  const sign = line.difference >= 0 ? '+' : '-';
  console.log(`  ${line.label.padEnd(12)} expected ${money(line.expected).padStart(11)}   ` +
    `actual ${money(line.actual).padStart(11)}   ${sign}${money(Math.abs(line.difference))}` +
    `${line.material ? '  ← material' : ''}`);
}
for (const finding of reconciliation.findings) console.log(`\n  ${finding}`);

// Three periods of the same pattern, so the learning threshold is met.
const learned = learnFromHistory([reconciliation, reconciliation, reconciliation]);
sub('What the system learned');
console.log(`  ${learned.ready ? learned.summary : learned.reason}`);

// ---------------------------------------------------------------------------
head('5. FAMILY BUDGET');

const bills = store.bills;
const overview = monthlyOverview({
  month: '2026-08',
  expectedIncome: 6420,
  asOf: '2026-08-05',
  nextPayday: '2026-08-07',
  bills,
});

console.log(`\n  AUGUST\n`);
console.log(`  Expected income           ${money(overview.expectedIncome).padStart(12)}`);
console.log(`  Bills tracked             ${String(overview.billCount).padStart(12)}`);
console.log(`  Already paid              ${money(overview.alreadyPaid).padStart(12)}`);
console.log(`  Upcoming                  ${money(overview.upcoming).padStart(12)}`);
console.log(`  Due before next paycheck  ${money(overview.dueBeforeNextPaycheck).padStart(12)}  (${overview.dueBeforeNextPaycheckCount} bills)`);

const safe = calculateSafeToSpend({
  currentBalance: 3200,
  pendingOutflows: 128.4,
  asOf: '2026-08-05',
  nextPayday: '2026-08-07',
  expectedIncomeBeforePayday: 0,
  bills,
  dailyVariableSpend: 35,
  sinkingFundContribution: 480,
  savingsGoals: [{ label: 'Baby fund', monthlyContribution: 300 }],
  bufferTarget: 2000,
  bufferBalance: 500,
});

sub('Safe to spend');
console.log(`  Starting point            ${money(safe.startingPoint).padStart(12)}`);
for (const d of safe.deductions) {
  console.log(`  ${d.label.padEnd(25).slice(0, 25)} ${('-' + money(d.amount)).padStart(12)}`);
  console.log(`    ${d.note}`);
}
console.log(`  ${'─'.repeat(40)}`);
console.log(`  SAFE TO SPEND             ${money(safe.safeToSpend).padStart(12)}   (${money(safe.perDay)}/day)`);
console.log(`\n  ${safe.headline}`);
for (const w of safe.warnings) console.log(`\n  ⚠ ${w}`);

console.log(`\n${'─'.repeat(72)}`);
console.log('  All figures above are derived from FIXTURE data. No email account,');
console.log('  payroll system, or bank is connected to this repository.');
console.log();
