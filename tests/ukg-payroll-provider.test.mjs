import test from 'node:test';
import assert from 'node:assert/strict';
import { createUkgPayrollProvider, normalizePaystub, normalizeTimeEntry } from '../src/providers/ukg/ukg-payroll-provider.js';

test('normalizes UKG timecard components without inventing missing values', () => {
  const entry = normalizeTimeEntry({
    entryId: 'shift-1',
    workDate: '2026-08-14',
    regular_hours: '10',
    overtime_hours: '2',
    standby_hours: '24',
    callback_hours: '0.5',
    callback_events: 1,
    differential_code: 'night',
    differential_hours: 10,
  }, { householdId: 'h1', payProfileId: 'p1' });

  assert.deepEqual({
    date: entry.date,
    regularHours: entry.regularHours,
    overtimeHours: entry.overtimeHours,
    standbyHours: entry.standbyHours,
    callbackHours: entry.callbackHours,
    callbackEvents: entry.callbackEvents,
    differentialCode: entry.differentialCode,
    differentialHours: entry.differentialHours,
    source: entry.source,
  }, {
    date: '2026-08-14',
    regularHours: 10,
    overtimeHours: 2,
    standbyHours: 24,
    callbackHours: 0.5,
    callbackEvents: 1,
    differentialCode: 'night',
    differentialHours: 10,
    source: 'provider_api',
  });
});

test('normalizes pay period, gross/net, earnings, deductions, and metadata', () => {
  const stub = normalizePaystub({
    statementId: 'stub-1',
    pay_date: '2026-08-21',
    pay_period_start: '2026-08-01',
    pay_period_end: '2026-08-14',
    gross_pay: '$3,100.00',
    net_pay: '2,200.00',
    total_taxes: '700.00',
    regular_hours: 80,
    overtime_hours: 4,
    earningLines: { regular: 2500, overtime: 600 },
    deduction_lines: [{ name: 'Medical', amount: 100, pre_tax: true }],
  });

  assert.equal(stub.payDate, '2026-08-21');
  assert.deepEqual(stub.period, { start: '2026-08-01', end: '2026-08-14' });
  assert.equal(stub.grossPay, 3100);
  assert.equal(stub.netPay, 2200);
  assert.equal(stub.overtimeHours, 4);
  assert.deepEqual(stub.earnings, { regular: 2500, overtime: 600 });
  assert.deepEqual(stub.deductions, [{ label: 'Medical', amount: 100, preTax: true }]);
  assert.equal(stub.sourceRef, 'stub-1');
});

test('uses runtime session cookie and remains read-only', async () => {
  const calls = [];
  const provider = createUkgPayrollProvider({
    baseUrl: 'https://tenant.example',
    endpoints: {
      timecard: ({ start, end }) => `/timecard?start=${start}&end=${end}`,
      paystubs: '/paystubs',
    },
    sessionStore: { get: () => 'UKG_SESSION=runtime-only' },
    transport: {
      request: async (input) => {
        calls.push(input);
        return { status: 200, data: { entries: [] } };
      },
    },
    householdId: 'h1',
  });

  assert.equal(await provider.isConnected(), true);
  await provider.getTimecard({ start: '2026-08-01', end: '2026-08-14' });
  assert.equal(calls.at(-1).method, 'GET');
  assert.equal(calls.at(-1).headers.cookie, 'UKG_SESSION=runtime-only');
  assert.equal(calls.every((call) => call.method === 'GET'), true);
});
