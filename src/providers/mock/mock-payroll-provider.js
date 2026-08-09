/**
 * Mock payroll provider — NOT A REAL INTEGRATION.
 *
 * `info.isLive` is false. No timekeeping system is contacted; this replays a
 * fixture timecard so the pay calculator and forecast can be tested.
 *
 * The fixture is a 4x10 schedule with call/standby/callback, because that is
 * the shape the calculator most needs to get right and the shape naive payroll
 * math handles worst.
 *
 * To connect a real system: implement `getTimecard` and `getPaystubs` against
 * its API and register that instead. Nothing else changes.
 */

import { makeTimeEntry, makePaystub } from '../../domain/payroll.js';

/**
 * Two weeks of a 4x10 rotation.
 *
 * Note what this exercises:
 *   - four 10-hour days per week, which a daily 8-hour OT rule would turn into
 *     8 hours of phantom overtime every week
 *   - a genuine overtime day (12 hours)
 *   - a week carrying standby, with two callbacks, one of them 30 minutes —
 *     well under any contractual minimum
 *   - a holiday and a PTO day
 */
export const MOCK_TIMECARD = [
  // Week 1 — standard 4x10.
  { date: '2026-07-20', regularHours: 10, startTime: '06:00', endTime: '16:30' },
  { date: '2026-07-21', regularHours: 10, startTime: '06:00', endTime: '16:30' },
  { date: '2026-07-22', regularHours: 10, startTime: '06:00', endTime: '16:30' },
  { date: '2026-07-23', regularHours: 10, startTime: '06:00', endTime: '16:30' },
  // On call over the weekend; called out twice on the Saturday.
  { date: '2026-07-25', standbyHours: 24, callbackHours: 0.5, callbackEvents: 1, notes: 'callout — breaker reset' },
  { date: '2026-07-26', standbyHours: 24, callbackHours: 3.25, callbackEvents: 1, notes: 'callout — line fault' },

  // Week 2 — a long day, a holiday, and PTO.
  { date: '2026-07-27', regularHours: 12, startTime: '06:00', endTime: '18:30', notes: 'storm response' },
  { date: '2026-07-28', regularHours: 10, startTime: '06:00', endTime: '16:30' },
  { date: '2026-07-29', holidayHours: 10, notes: 'company holiday' },
  { date: '2026-07-30', ptoHours: 10, notes: 'PTO' },
  { date: '2026-07-31', regularHours: 10, startTime: '18:00', endTime: '04:30', differentialCode: 'night', differentialHours: 10 },
];

export const MOCK_PAYSTUBS = [
  {
    payDate: '2026-07-10',
    period: { start: '2026-06-22', end: '2026-07-05' },
    grossPay: 2884.5,
    netPay: 2043.28,
    totalTaxes: 649.01,
    regularHours: 80,
    overtimeHours: 4,
    deductions: [
      { label: 'Medical', amount: 142.21, preTax: true },
      { label: 'Union Dues', amount: 50.0 },
    ],
    sourceRef: 'stub_2026_07_10',
  },
  {
    payDate: '2026-06-26',
    period: { start: '2026-06-08', end: '2026-06-21' },
    grossPay: 2610.0,
    netPay: 1856.44,
    totalTaxes: 561.35,
    regularHours: 80,
    overtimeHours: 0,
    deductions: [
      { label: 'Medical', amount: 142.21, preTax: true },
      { label: 'Union Dues', amount: 50.0 },
    ],
    sourceRef: 'stub_2026_06_26',
  },
  {
    payDate: '2026-06-12',
    period: { start: '2026-05-25', end: '2026-06-07' },
    grossPay: 3102.75,
    netPay: 2187.9,
    totalTaxes: 722.64,
    regularHours: 80,
    overtimeHours: 8,
    deductions: [
      { label: 'Medical', amount: 142.21, preTax: true },
      { label: 'Union Dues', amount: 50.0 },
    ],
    sourceRef: 'stub_2026_06_12',
  },
];

/**
 * @param {object} [options]
 * @param {string} [options.householdId]
 * @param {boolean} [options.connected=true]
 * @returns {import('../types.js').PayrollProvider}
 */
export function createMockPayrollProvider(options = {}) {
  const householdId = options.householdId ?? 'mock-household';
  const connected = options.connected ?? true;

  return {
    info: {
      key: 'mock-payroll',
      displayName: 'Mock Payroll (fixtures)',
      kind: 'payroll',
      isLive: false,
      authType: 'none',
    },

    capabilities: { incremental: false },

    async isConnected() {
      return connected;
    },

    async getTimecard(period) {
      return MOCK_TIMECARD
        .filter((e) => e.date >= period.start && e.date <= period.end)
        .map((e) => makeTimeEntry({
          ...e,
          householdId,
          source: 'timecard_import',
          sourceRef: `mock_${e.date}`,
        }));
    },

    async getPaystubs(opts = {}) {
      return MOCK_PAYSTUBS
        .filter((s) => !opts.since || s.payDate >= opts.since)
        .map((s) => makePaystub({
          ...s,
          householdId,
          source: 'provider_api',
          confidence: 1,
        }));
    },
  };
}
