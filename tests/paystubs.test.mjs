/**
 * Paystub <-> Postgres row mapping round trip, plus the reconciliation loop
 * end to end: forecast -> real stub -> reconciliation -> learned adjustments.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stubToRow, rowToStub, deductionToRow, rowToDeduction,
  reconciliationToRow, rowToReconciliationSummary,
} from '../src/payroll/mapping.js';
import { makePaystub, validatePaystub, makePayProfile, makeTimeEntry } from '../src/domain/payroll.js';
import { reconcilePaycheck, learnFromHistory, applyLearnedAdjustments } from '../src/payroll/reconcile.js';
import { forecastPaycheck } from '../src/payroll/forecast.js';

test('a fully populated paystub survives a round trip through row shape', () => {
  const stub = makePaystub({
    id: 'ps_1',
    householdId: 'house_1',
    payProfileId: 'pp_1',
    payDate: '2026-08-07',
    period: { start: '2026-07-20', end: '2026-08-02' },
    grossPay: 1700,
    netPay: 1150,
    totalTaxes: 357.79,
    regularHours: 80,
    overtimeHours: 0,
    earnings: { Regular: 1700 },
    source: 'pdf',
    sourceRef: 'msg_paystub_001',
    confidence: 0.9,
  });

  const row = stubToRow(stub, 'house_1');
  assert.equal(row.household_id, 'house_1');
  assert.equal(row.pay_profile_id, 'pp_1');
  assert.equal(row.pay_date, '2026-08-07');
  assert.equal(row.period_start, '2026-07-20');
  assert.equal(row.period_end, '2026-08-02');
  assert.equal(row.gross_pay, 1700);
  assert.equal(row.net_pay, 1150);
  assert.equal(row.source_ref, 'msg_paystub_001');

  const back = rowToStub({ ...row, id: 'ps_1' });
  assert.equal(back.id, 'ps_1');
  assert.equal(back.householdId, 'house_1');
  assert.equal(back.payProfileId, stub.payProfileId);
  assert.equal(back.payDate, stub.payDate);
  assert.deepEqual(back.period, stub.period);
  assert.equal(back.grossPay, stub.grossPay);
  assert.equal(back.netPay, stub.netPay);
  assert.equal(back.regularHours, stub.regularHours);
  assert.equal(back.totalTaxes, stub.totalTaxes);
  assert.equal(back.source, stub.source);
  assert.equal(back.sourceRef, stub.sourceRef);
  assert.equal(back.confidence, stub.confidence);
  assert.deepEqual(back.earnings, stub.earnings);
});

test('deductions round-trip as their own rows, joined back onto the stub', () => {
  const row = deductionToRow({ label: 'Medical', amount: 142.21, preTax: true }, 'house_1', 'ps_1');
  assert.equal(row.household_id, 'house_1');
  assert.equal(row.paystub_id, 'ps_1');
  assert.equal(row.label, 'Medical');
  assert.equal(row.amount, 142.21);
  assert.equal(row.pre_tax, true);

  const back = rowToDeduction(row);
  assert.equal(back.label, 'Medical');
  assert.equal(back.amount, 142.21);
  assert.equal(back.preTax, true);

  const stubRow = stubToRow(makePaystub({
    householdId: 'house_1', payDate: '2026-08-07',
    period: { start: '2026-07-20', end: '2026-08-02' },
    grossPay: 1700, netPay: 1150, totalTaxes: 357.79, source: 'manual',
  }), 'house_1');
  const rebuilt = rowToStub({ ...stubRow, id: 'ps_1' }, [row]);
  assert.equal(rebuilt.deductions.length, 1);
  assert.equal(rebuilt.deductions[0].label, 'Medical');
});

test('rowToStub converts numeric columns even when PostgREST hands them back as strings', () => {
  const row = {
    id: 'ps_2', household_id: 'h', pay_profile_id: null, pay_date: '2026-08-07',
    period_start: '2026-07-20', period_end: '2026-08-02',
    gross_pay: '1700.00', net_pay: '1150.00', total_taxes: '357.79',
    regular_hours: '80.0', overtime_hours: null, earnings: {}, source: 'manual',
    source_ref: null, confidence: '1.000',
  };
  const stub = rowToStub(row);
  assert.equal(stub.grossPay, 1700);
  assert.strictEqual(typeof stub.grossPay, 'number');
  assert.equal(stub.regularHours, 80);
  assert.equal(stub.confidence, 1);
  assert.strictEqual(typeof stub.confidence, 'number');
});

test('a reconciliation summary survives a round trip through row shape', () => {
  const reconciliation = {
    paystubId: 'ps_1',
    gross: { expected: 1700, actual: 1700 },
    net: { expected: 1150, actual: 1140 },
    taxes: { expected: 357.79, actual: 360 },
    deductions: { expected: 192.21, actual: 192.21 },
    materialVariance: false,
    findings: ['Actual gross matched forecast within tolerance.'],
    derivedRates: { effectiveTaxRate: 0.24 },
  };

  const row = reconciliationToRow(reconciliation, 'house_1', 'forecast_1');
  assert.equal(row.household_id, 'house_1');
  assert.equal(row.paystub_id, 'ps_1');
  assert.equal(row.forecast_id, 'forecast_1');
  assert.equal(row.expected_gross, 1700);
  assert.equal(row.actual_net, 1140);
  assert.deepEqual(row.derived_rates, { effectiveTaxRate: 0.24 });

  const back = rowToReconciliationSummary({ ...row, id: 'recon_1', created_at: '2026-08-07T12:00:00Z' });
  assert.equal(back.id, 'recon_1');
  assert.equal(back.paystubId, 'ps_1');
  assert.equal(back.expectedGross, 1700);
  assert.equal(back.actualNet, 1140);
  assert.deepEqual(back.findings, reconciliation.findings);
  assert.deepEqual(back.derivedRates, reconciliation.derivedRates);
  assert.equal(back.createdAt, '2026-08-07T12:00:00Z');
});

test('three consistent paystubs reconciled against forecasts produce a suggested tax rate', () => {
  const profile = makePayProfile({
    householdId: 'h1',
    baseHourlyRate: 42.5,
    weeklyOvertimeThreshold: 40,
    taxAssumptions: { federalRate: 0.12, stateRate: 0.05, socialSecurityRate: 0.062, medicareRate: 0.0145 },
    payFrequency: 'biweekly',
    payPeriodStart: '2026-06-22',
    payPeriodEnd: '2026-07-05',
    payday: '2026-07-10',
  });

  const periods = [
    { start: '2026-06-22', end: '2026-07-05', payDate: '2026-07-10' },
    { start: '2026-07-06', end: '2026-07-19', payDate: '2026-07-24' },
    { start: '2026-07-20', end: '2026-08-02', payDate: '2026-08-07' },
  ];

  const reconciliations = periods.map((period) => {
    const entries = [
      makeTimeEntry({ householdId: 'h1', date: period.start, regularHours: 10 }),
      makeTimeEntry({ householdId: 'h1', date: period.start, regularHours: 10 }),
      makeTimeEntry({ householdId: 'h1', date: period.start, regularHours: 10 }),
      makeTimeEntry({ householdId: 'h1', date: period.start, regularHours: 10 }),
    ];
    const forecast = forecastPaycheck({ profile, entries, period, payDate: period.payDate });
    const stub = makePaystub({
      householdId: 'h1',
      payDate: period.payDate,
      period,
      grossPay: forecast.breakdown.totalGross,
      netPay: forecast.breakdown.estimatedNet * 0.9,
      totalTaxes: forecast.breakdown.totalTaxes * 1.3,
      source: 'manual',
    });
    return reconcilePaycheck(forecast, stub);
  });

  const learned = learnFromHistory(reconciliations);
  assert.equal(learned.ready, true);
  assert.equal(learned.sampleSize, 3);
  assert.ok(learned.suggestedTaxRate > 0);

  const { changed } = applyLearnedAdjustments(profile, learned);
  assert.equal(changed, true);
});

test('validatePaystub rejects net pay exceeding gross pay', () => {
  const stub = makePaystub({
    householdId: 'h1', payDate: '2026-08-07',
    period: { start: '2026-07-20', end: '2026-08-02' },
    grossPay: 1000, netPay: 1200, totalTaxes: 100, source: 'manual',
  });
  const { valid, errors } = validatePaystub(stub);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /netPay exceeds grossPay/.test(e)));
});
