import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaydayEvents } from '../web/payday-events.js';

test('shows observed payroll deposits and the next biweekly payday in the same month', () => {
  const streams = [{
    account_id: 'checking',
    payee: 'Hospital Payroll',
    cadence: 'biweekly',
    typical_amount: 3156.03,
    last_amount: 4140.65,
    dates: ['2026-07-17', '2026-07-31'],
    amounts: [2685.23, 4140.65],
    last_seen: '2026-07-31',
    next_expected: '2026-08-14',
  }];

  assert.deepEqual(buildPaydayEvents(streams, '2026-08'), [
    {
      date: '2026-08-14', status: 'expected', amount: 3156.03,
      payee: 'Hospital Payroll', cadence: 'biweekly',
    },
    {
      date: '2026-08-28', status: 'expected', amount: 3156.03,
      payee: 'Hospital Payroll', cadence: 'biweekly',
    },
  ]);
});

test('uses the actual deposit instead of duplicating an expected payday', () => {
  const streams = [{
    account_id: 'checking',
    payee: 'Hospital Payroll',
    cadence: 'biweekly',
    typical_amount: 3200,
    last_amount: 3300,
    dates: ['2026-07-31', '2026-08-14'],
    amounts: [4140.65, 3300],
    last_seen: '2026-08-14',
    next_expected: '2026-08-28',
  }];

  assert.deepEqual(buildPaydayEvents(streams, '2026-08'), [
    {
      date: '2026-08-14', status: 'deposited', amount: 3300,
      payee: 'Hospital Payroll', cadence: 'biweekly',
    },
    {
      date: '2026-08-28', status: 'expected', amount: 3200,
      payee: 'Hospital Payroll', cadence: 'biweekly',
    },
  ]);
});

test('walks projections forward into later calendar months', () => {
  const streams = [{
    account_id: 'checking',
    payee: 'Hospital Payroll',
    cadence: 'biweekly',
    typical_amount: 3156.03,
    dates: ['2026-07-31'],
    amounts: [4140.65],
    last_seen: '2026-07-31',
    next_expected: '2026-08-14',
  }];

  const september = buildPaydayEvents(streams, '2026-09');
  assert.equal(september[0].date, '2026-09-11');
  assert.equal(september[1].date, '2026-09-25');
  assert.ok(september.every((event) => event.status === 'expected'));
});
