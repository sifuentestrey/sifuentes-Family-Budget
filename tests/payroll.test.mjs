/**
 * Pay calculation, forecast, and reconciliation.
 *
 * The 4x10 and callback cases are the ones that matter — they are where naive
 * payroll math produces confidently wrong take-home figures.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTimeEntry, makePayProfile, makePaystub, validatePayProfile, validateTimeEntry } from '../src/domain/payroll.js';
import { calculatePay, splitRegularAndOvertime, calculateCallbackHours, calculateStandby } from '../src/payroll/pay-calculator.js';
import { forecastPaycheck, nextPayPeriod } from '../src/payroll/forecast.js';
import { reconcilePaycheck, learnFromHistory, applyLearnedAdjustments } from '../src/payroll/reconcile.js';
import { createMockPayrollProvider } from '../src/providers/mock/mock-payroll-provider.js';

/** A 4x10 profile: no daily OT, weekly threshold at 40. */
const fourByTen = makePayProfile({
  householdId: 'h1',
  label: 'Test 4x10',
  baseHourlyRate: 42.5,
  overtimeMultiplier: 1.5,
  dailyOvertimeThreshold: 0,
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
  taxAssumptions: {
    federalRate: 0.12, stateRate: 0.05, socialSecurityRate: 0.062, medicareRate: 0.0145,
  },
  payFrequency: 'biweekly',
  payPeriodStart: '2026-07-20',
  payPeriodEnd: '2026-08-02',
  payday: '2026-08-07',
});

const entry = (overrides) => makeTimeEntry({ householdId: 'h1', ...overrides });

// ---------------------------------------------------------------------------
// Overtime — the 4x10 trap
// ---------------------------------------------------------------------------

test('a 4x10 week produces no overtime when daily OT is disabled', () => {
  // Four 10-hour days is exactly 40 hours. A fixed 8-hour daily rule would
  // report 8 hours of overtime here — roughly $340 of pay that does not exist.
  const week = [
    entry({ date: '2026-07-20', regularHours: 10 }),
    entry({ date: '2026-07-21', regularHours: 10 }),
    entry({ date: '2026-07-22', regularHours: 10 }),
    entry({ date: '2026-07-23', regularHours: 10 }),
  ];
  const result = splitRegularAndOvertime(week, fourByTen);
  assert.equal(result.regularHours, 40);
  assert.equal(result.overtimeHours, 0);
});

test('an 8-hour daily threshold would manufacture overtime on the same week', () => {
  // Documents the failure mode explicitly, so nobody "fixes" the default back.
  const eightHourProfile = makePayProfile({ ...fourByTen, dailyOvertimeThreshold: 8 });
  const week = [
    entry({ date: '2026-07-20', regularHours: 10 }),
    entry({ date: '2026-07-21', regularHours: 10 }),
    entry({ date: '2026-07-22', regularHours: 10 }),
    entry({ date: '2026-07-23', regularHours: 10 }),
  ];
  const result = splitRegularAndOvertime(week, eightHourProfile);
  assert.equal(result.overtimeHours, 8, 'this is why the daily threshold defaults to disabled');
});

test('weekly overtime is counted past 40 hours', () => {
  const week = [
    entry({ date: '2026-07-20', regularHours: 10 }),
    entry({ date: '2026-07-21', regularHours: 10 }),
    entry({ date: '2026-07-22', regularHours: 10 }),
    entry({ date: '2026-07-23', regularHours: 10 }),
    entry({ date: '2026-07-24', regularHours: 6 }),
  ];
  const result = splitRegularAndOvertime(week, fourByTen);
  assert.equal(result.regularHours, 40);
  assert.equal(result.overtimeHours, 6);
});

test('daily and weekly overtime never double-count the same hour', () => {
  const profile = makePayProfile({ ...fourByTen, dailyOvertimeThreshold: 10, weeklyOvertimeThreshold: 40 });
  const week = [
    entry({ date: '2026-07-20', regularHours: 12 }),
    entry({ date: '2026-07-21', regularHours: 10 }),
    entry({ date: '2026-07-22', regularHours: 10 }),
    entry({ date: '2026-07-23', regularHours: 10 }),
  ];
  const result = splitRegularAndOvertime(week, profile);
  // 2h daily OT on the 12h day; the remaining 40 regular hours are at the
  // weekly threshold, so nothing more converts.
  assert.equal(result.overtimeHours, 2);
  assert.equal(result.regularHours, 40);
});

test('employer-reported overtime is trusted rather than re-derived', () => {
  const week = [
    entry({ date: '2026-07-20', regularHours: 10, overtimeHours: 2 }),
    entry({ date: '2026-07-21', regularHours: 10 }),
    entry({ date: '2026-07-22', regularHours: 10 }),
    entry({ date: '2026-07-23', regularHours: 10 }),
  ];
  const result = splitRegularAndOvertime(week, fourByTen);
  assert.equal(result.overtimeHours, 2, 'must not add derived OT on top of reported OT');
});

// ---------------------------------------------------------------------------
// Callback minimums
// ---------------------------------------------------------------------------

test('a short callback pays the contractual minimum', () => {
  const entries = [entry({ date: '2026-07-25', callbackHours: 0.5, callbackEvents: 1 })];
  const result = calculateCallbackHours(entries, fourByTen);
  assert.equal(result.callbackActualHours, 0.5);
  assert.equal(result.callbackPaidHours, 2, '30 minutes worked, 2-hour minimum paid');
});

test('each callback event earns the minimum separately', () => {
  // Two 30-minute callouts in one night is 4 paid hours, not 2.
  const entries = [entry({ date: '2026-07-25', callbackHours: 1, callbackEvents: 2 })];
  const result = calculateCallbackHours(entries, fourByTen);
  assert.equal(result.callbackPaidHours, 4);
});

test('a long callback pays actual hours, not the minimum', () => {
  const entries = [entry({ date: '2026-07-26', callbackHours: 3.25, callbackEvents: 1 })];
  const result = calculateCallbackHours(entries, fourByTen);
  assert.equal(result.callbackPaidHours, 3.25);
});

test('no configured minimum pays actual hours', () => {
  const noMinimum = makePayProfile({ ...fourByTen, callbackMinimumHours: 0 });
  const entries = [entry({ date: '2026-07-25', callbackHours: 0.5, callbackEvents: 1 })];
  assert.equal(calculateCallbackHours(entries, noMinimum).callbackPaidHours, 0.5);
});

// ---------------------------------------------------------------------------
// Standby
// ---------------------------------------------------------------------------

test('hourly standby pays per hour on call', () => {
  const entries = [
    entry({ date: '2026-07-25', standbyHours: 24 }),
    entry({ date: '2026-07-26', standbyHours: 24 }),
  ];
  const result = calculateStandby(entries, fourByTen);
  assert.equal(result.standbyUnits, 48);
  assert.equal(result.standbyGross, 168);
});

test('daily standby pays per day regardless of hours', () => {
  const daily = makePayProfile({ ...fourByTen, standbyIsDaily: true, standbyRate: 45 });
  const entries = [
    entry({ date: '2026-07-25', standbyHours: 24 }),
    entry({ date: '2026-07-26', standbyHours: 12 }),
  ];
  const result = calculateStandby(entries, daily);
  assert.equal(result.standbyUnits, 2);
  assert.equal(result.standbyGross, 90);
});

test('standby hours do not count toward overtime', () => {
  // On call is not worked. Counting it would convert a quiet weekend into
  // 48 hours of overtime.
  const entries = [
    entry({ date: '2026-07-20', regularHours: 10 }),
    entry({ date: '2026-07-21', regularHours: 10 }),
    entry({ date: '2026-07-22', regularHours: 10 }),
    entry({ date: '2026-07-23', regularHours: 10 }),
    entry({ date: '2026-07-25', standbyHours: 24 }),
  ];
  assert.equal(splitRegularAndOvertime(entries, fourByTen).overtimeHours, 0);
});

// ---------------------------------------------------------------------------
// Full calculation
// ---------------------------------------------------------------------------

test('holiday pay uses the holiday multiplier', () => {
  const entries = [entry({ date: '2026-07-29', holidayHours: 10 })];
  const result = calculatePay(entries, fourByTen);
  assert.equal(result.holidayGross, 10 * 42.5 * 1.5);
  assert.equal(result.overtimeHours, 0, 'holiday hours are not worked hours');
});

test('PTO pays straight time', () => {
  const result = calculatePay([entry({ date: '2026-07-30', ptoHours: 10 })], fourByTen);
  assert.equal(result.ptoGross, 425);
});

test('differentials add to base pay rather than replacing it', () => {
  const entries = [entry({ date: '2026-07-31', regularHours: 10, differentialCode: 'night', differentialHours: 10 })];
  const result = calculatePay(entries, fourByTen);
  assert.equal(result.regularGross, 425, 'base pay still applies');
  assert.equal(result.differentialGross, 22.5, '10h at $2.25 extra');
  assert.equal(result.totalGross, 447.5);
});

test('pre-tax deductions reduce taxable gross, post-tax do not', () => {
  const entries = [entry({ date: '2026-07-20', regularHours: 10 })];
  const result = calculatePay(entries, fourByTen);
  assert.equal(result.totalGross, 425);
  // Medical is pre-tax; union dues are not. Rounded, because 425 - 142.21
  // evaluates to 282.78999999999996 in floating point and the engine rounds
  // every money figure to cents.
  assert.equal(result.taxableGross, Math.round((425 - 142.21) * 100) / 100);
  assert.equal(result.totalDeductions, 192.21);
});

test('net is gross minus taxes and all deductions', () => {
  const entries = [entry({ date: '2026-07-20', regularHours: 10 })];
  const result = calculatePay(entries, fourByTen);
  const expected = result.totalGross - result.totalTaxes - result.totalDeductions;
  assert.equal(result.estimatedNet, Math.round(expected * 100) / 100);
});

test('the full mock timecard produces a coherent breakdown', () => {
  const provider = createMockPayrollProvider({ householdId: 'h1' });
  return provider.getTimecard({ start: '2026-07-20', end: '2026-08-02' }).then((entries) => {
    const result = calculatePay(entries, fourByTen);

    assert.ok(result.totalGross > 0);
    assert.ok(result.callbackPaidHours > result.callbackActualHours, 'callback minimum applied');
    assert.ok(result.standbyGross > 0);
    assert.ok(result.holidayGross > 0);
    assert.ok(result.differentialGross > 0);
    assert.ok(result.estimatedNet < result.totalGross);

    const componentSum = result.regularGross + result.overtimeGross + result.standbyGross
      + result.callbackGross + result.holidayGross + result.ptoGross + result.differentialGross;
    assert.equal(result.totalGross, Math.round(componentSum * 100) / 100);
  });
});

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

test('a complete period forecasts with high confidence', () => {
  const entries = [
    entry({ date: '2026-07-20', regularHours: 10, source: 'timecard_import' }),
    entry({ date: '2026-07-21', regularHours: 10, source: 'timecard_import' }),
    entry({ date: '2026-07-22', regularHours: 10, source: 'timecard_import' }),
    entry({ date: '2026-07-23', regularHours: 10, source: 'timecard_import' }),
  ];
  const forecast = forecastPaycheck({
    profile: fourByTen,
    entries,
    period: { start: '2026-07-20', end: '2026-08-02' },
    payDate: '2026-08-07',
    asOf: '2026-08-03',
  });
  assert.equal(forecast.periodComplete, true);
  assert.equal(forecast.confidence, 'high');
  assert.ok(forecast.estimatedNet > 0);
});

test('a barely-started period forecasts with low confidence', () => {
  const forecast = forecastPaycheck({
    profile: fourByTen,
    entries: [entry({ date: '2026-07-20', regularHours: 10, source: 'manual' })],
    period: { start: '2026-07-20', end: '2026-08-02' },
    payDate: '2026-08-07',
    asOf: '2026-07-21',
  });
  assert.equal(forecast.confidence, 'low');
  assert.ok(forecast.confidenceReasons.some((r) => /elapsed/.test(r)));
});

test('an empty period is honest about having nothing to forecast from', () => {
  const forecast = forecastPaycheck({
    profile: fourByTen,
    entries: [],
    period: { start: '2026-08-03', end: '2026-08-16' },
    payDate: '2026-08-21',
    asOf: '2026-08-04',
  });
  assert.equal(forecast.confidence, 'low');
  assert.equal(forecast.confidenceScore, 0);
  assert.match(forecast.confidenceReasons[0], /no time entries/);
});

test('a partial period projects forward separately from earned-to-date', () => {
  const forecast = forecastPaycheck({
    profile: fourByTen,
    entries: [
      entry({ date: '2026-07-20', regularHours: 10, source: 'timecard_import' }),
      entry({ date: '2026-07-21', regularHours: 10, source: 'timecard_import' }),
    ],
    period: { start: '2026-07-20', end: '2026-08-02' },
    payDate: '2026-08-07',
    asOf: '2026-07-24',
  });
  assert.ok(forecast.projectedFromPartial > forecast.estimatedNet,
    'projection must not be presented as money already earned');
});

test('biweekly pay periods advance without drifting', () => {
  const next = nextPayPeriod(fourByTen, '2026-08-20');
  assert.equal(next.period.start, '2026-08-17');
  assert.equal(next.period.end, '2026-08-30');
  assert.equal(next.payDate, '2026-09-04', 'the 5-day lag is preserved');
});

test('semi-monthly periods anchor to calendar dates', () => {
  const semi = makePayProfile({
    ...fourByTen,
    payFrequency: 'semimonthly',
    payPeriodStart: '2026-07-01',
    payPeriodEnd: '2026-07-15',
    payday: '2026-07-20',
  });
  const next = nextPayPeriod(semi, '2026-08-20');
  assert.equal(next.period.start, '2026-08-16');
  assert.equal(next.period.end, '2026-08-31', 'end of month, not a fixed offset');
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

function forecastFor(entries, asOf = '2026-08-03') {
  return forecastPaycheck({
    profile: fourByTen,
    entries,
    period: { start: '2026-07-20', end: '2026-08-02' },
    payDate: '2026-08-07',
    asOf,
  });
}

test('reconciliation reports the difference in each line', () => {
  const forecast = forecastFor([entry({ date: '2026-07-20', regularHours: 40 })]);
  const stub = makePaystub({
    householdId: 'h1',
    payDate: '2026-08-07',
    period: { start: '2026-07-20', end: '2026-08-02' },
    grossPay: 1700,
    netPay: 1150,
    totalTaxes: 357.79,
    deductions: [{ label: 'Medical', amount: 142.21, preTax: true }, { label: 'Union Dues', amount: 50 }],
  });

  const result = reconcilePaycheck(forecast, stub);
  assert.equal(result.gross.expected, 1700);
  assert.equal(result.gross.actual, 1700);
  assert.equal(result.gross.difference, 0);
  assert.equal(result.net.actual, 1150);
});

test('matching gross with missed net points at taxes, not hours', () => {
  const forecast = forecastFor([entry({ date: '2026-07-20', regularHours: 40 })]);
  const stub = makePaystub({
    householdId: 'h1',
    payDate: '2026-08-07',
    period: { start: '2026-07-20', end: '2026-08-02' },
    grossPay: forecast.breakdown.totalGross,
    netPay: forecast.breakdown.estimatedNet * 0.85,
    totalTaxes: forecast.breakdown.totalTaxes * 1.4,
    deductions: [],
  });

  const result = reconcilePaycheck(forecast, stub);
  assert.equal(result.gross.material, false);
  assert.equal(result.net.material, true);
  assert.ok(result.findings.some((f) => /taxes or deductions/.test(f)));
});

test('a deduction on the stub but not the profile is called out', () => {
  const forecast = forecastFor([entry({ date: '2026-07-20', regularHours: 40 })]);
  const stub = makePaystub({
    householdId: 'h1',
    payDate: '2026-08-07',
    period: { start: '2026-07-20', end: '2026-08-02' },
    grossPay: forecast.breakdown.totalGross,
    netPay: forecast.breakdown.estimatedNet - 75,
    totalTaxes: forecast.breakdown.totalTaxes,
    deductions: [
      { label: 'Medical', amount: 142.21, preTax: true },
      { label: 'Union Dues', amount: 50 },
      { label: 'Garnishment', amount: 75 },
    ],
  });

  const result = reconcilePaycheck(forecast, stub);
  assert.ok(result.findings.some((f) => /Garnishment/.test(f)));
});

test('learning waits for enough samples', () => {
  const learned = learnFromHistory([{ gross: { actual: 100 }, net: { percentDifference: -5 }, deductionDetail: [], derivedRates: {} }]);
  assert.equal(learned.ready, false);
  assert.match(learned.reason, /3 paychecks/);
});

test('learning derives an effective tax rate from real stubs', () => {
  const history = [0.24, 0.245, 0.238].map((rate, i) => ({
    gross: { actual: 3000 },
    net: { percentDifference: -6 - i },
    deductionDetail: [],
    derivedRates: { effectiveTaxRate: rate },
  }));

  const learned = learnFromHistory(history);
  assert.equal(learned.ready, true);
  assert.equal(learned.sampleSize, 3);
  assert.ok(learned.suggestedTaxRate > 0.23 && learned.suggestedTaxRate < 0.25);
  assert.ok(learned.consistentlyOver, 'forecasts ran high, so take-home is less than predicted');
});

test('a deduction seen on most stubs is suggested for the profile', () => {
  const history = [1, 2, 3].map(() => ({
    gross: { actual: 3000 },
    net: { percentDifference: -3 },
    deductionDetail: [{ label: 'Garnishment', expected: 0, actual: 75, difference: 75, material: true }],
    derivedRates: { effectiveTaxRate: 0.24 },
  }));

  const learned = learnFromHistory(history);
  assert.equal(learned.suggestedDeductions.length, 1);
  assert.equal(learned.suggestedDeductions[0].label, 'Garnishment');
  assert.equal(learned.suggestedDeductions[0].amount, 75);
});

test('applying adjustments returns a new profile and never mutates', () => {
  const learned = learnFromHistory([1, 2, 3].map(() => ({
    gross: { actual: 3000 },
    net: { percentDifference: -8 },
    deductionDetail: [],
    derivedRates: { effectiveTaxRate: 0.28 },
  })));

  const before = JSON.stringify(fourByTen);
  const { profile, changed, changes } = applyLearnedAdjustments(fourByTen, learned);

  assert.equal(changed, true);
  assert.ok(changes.length > 0);
  assert.equal(JSON.stringify(fourByTen), before, 'original profile untouched');
  assert.notEqual(profile.taxAssumptions.federalRate, fourByTen.taxAssumptions.federalRate);
  // Statutory FICA rates are known exactly and must not be "learned".
  assert.equal(profile.taxAssumptions.socialSecurityRate, 0.062);
  assert.equal(profile.taxAssumptions.medicareRate, 0.0145);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('a tax rate given as a percentage is rejected', () => {
  const bad = makePayProfile({
    ...fourByTen,
    taxAssumptions: { federalRate: 12, stateRate: 0.05, socialSecurityRate: 0.062, medicareRate: 0.0145 },
  });
  const { valid, errors } = validatePayProfile(bad);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /rate between 0 and 1/.test(e)));
});

test('worked hours beyond 24 in a day are rejected but standby is allowed', () => {
  assert.equal(validateTimeEntry(entry({ date: '2026-07-20', regularHours: 20, callbackHours: 8 })).valid, false);
  // 10 worked + 24 on call is a normal on-call day, not an error.
  assert.equal(validateTimeEntry(entry({ date: '2026-07-20', regularHours: 10, standbyHours: 24 })).valid, true);
});

test('an implausible error is refused rather than learned from', () => {
  // A 1000% miss means the forecast was matched to the wrong period or built
  // from an empty timecard. Suggesting a tax adjustment from that would bake
  // the mistake into every future estimate.
  const broken = [1, 2, 3].map(() => ({
    gross: { actual: 2884.5 },
    net: { percentDifference: 1163 },
    deductionDetail: [],
    derivedRates: { effectiveTaxRate: 0.225 },
  }));

  const learned = learnFromHistory(broken);
  assert.equal(learned.ready, false);
  assert.equal(learned.suggestedTaxRate, undefined, 'must not suggest a rate from nonsense');
  assert.match(learned.reason, /too large to be a tax or deduction problem/);
});

test('a plausible error still produces adjustments', () => {
  const normal = [1, 2, 3].map(() => ({
    gross: { actual: 4647.69 },
    net: { percentDifference: -8.2 },
    deductionDetail: [{ label: 'Garnishment', expected: 0, actual: 75, difference: 75, material: true }],
    derivedRates: { effectiveTaxRate: 0.282 },
  }));

  const learned = learnFromHistory(normal);
  assert.equal(learned.ready, true);
  assert.ok(learned.suggestedTaxRate > 0.27);
  assert.equal(learned.suggestedDeductions[0].label, 'Garnishment');
});
