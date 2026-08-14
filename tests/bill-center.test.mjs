import test from 'node:test';
import assert from 'node:assert/strict';

import {
  billPreferences,
  buildBillMonth,
  buildUpcomingObligations,
  obligationProvidersMatch,
} from '../src/engine/bill-center.js';

const bill = (overrides = {}) => ({
  id: 'bill-1',
  providerName: 'City Power',
  providerKey: 'city-power',
  category: 'Utilities',
  amountDue: 180,
  dueDate: '2026-08-05',
  status: 'confirmed',
  source: 'bank',
  raw: null,
  ...overrides,
});

const stream = (overrides = {}) => ({
  account_id: 'acct-1',
  payee: 'City Power',
  category: 'Utilities',
  kind: 'bill',
  cadence: 'monthly',
  fixedPrice: false,
  last_amount: 220,
  typical_amount: 195,
  amounts: [170, 205, 220],
  dates: ['2026-06-05', '2026-07-05', '2026-08-05'],
  last_seen: '2026-08-05',
  next_expected: '2026-09-05',
  ...overrides,
});

test('a paid mortgage stays in August while the next Sep 1 mortgage stays upcoming', () => {
  const mortgage = bill({
    providerName: 'Pennymac',
    providerKey: 'pennymac',
    category: 'Rent/Mortgage',
    amountDue: 1846.81,
    dueDate: '2026-09-01',
  });
  const mortgageStream = stream({
    payee: 'PENNYMAC LOAN SERVICES',
    category: 'Rent/Mortgage',
    fixedPrice: true,
    last_amount: 1846.81,
    typical_amount: 1846.81,
    amounts: [1846.81, 1846.81, 1846.81],
    dates: ['2026-06-29', '2026-07-03', '2026-08-03'],
    last_seen: '2026-08-03',
    next_expected: '2026-09-03',
  });

  const august = buildBillMonth({
    bills: [mortgage], recurring: [mortgageStream], month: '2026-08',
  });
  assert.equal(august.rows.length, 1);
  assert.equal(august.rows[0].paid, true);
  assert.equal(august.rows[0].paidDate, '2026-08-03');
  assert.equal(august.rows[0].paidAmount, 1846.81);

  const upcoming = buildUpcomingObligations({
    bills: [mortgage], recurring: [mortgageStream], asOf: '2026-08-14',
  });
  assert.equal(upcoming.length, 1, 'tracked mortgage replaces the bank projection');
  assert.equal(upcoming[0].dueDate, '2026-09-01');
  assert.equal(upcoming[0].providerName, 'Pennymac');
});

test('an active subscription is an automatic bill even before this month charge clears', () => {
  const google = stream({
    payee: 'Google',
    category: 'Subscriptions',
    kind: 'subscription',
    fixedPrice: true,
    last_amount: 3.19,
    typical_amount: 3.19,
    amounts: [3.19, 3.19],
    dates: ['2026-06-15', '2026-07-15'],
    last_seen: '2026-07-15',
    next_expected: '2026-08-15',
  });

  const august = buildBillMonth({ recurring: [google], month: '2026-08' });
  assert.equal(august.rows.length, 1);
  assert.equal(august.rows[0].paid, false);
  assert.equal(august.rows[0].paymentMode, 'auto');
  assert.equal(august.rows[0].kind, 'subscription');
  assert.equal(august.totals.remaining, 3.19);

  const upcoming = buildUpcomingObligations({ recurring: [google], asOf: '2026-08-14' });
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0].dueDate, '2026-08-15');
  assert.equal(upcoming[0].paymentMode, 'auto');
});

test('same-provider charges on the same day render as one paid Google row', () => {
  const google = stream({
    payee: 'Google',
    category: 'Subscriptions',
    kind: 'subscription',
    fixedPrice: true,
    last_amount: 3.19,
    typical_amount: 3.19,
    amounts: [3.19, 3.19, 3.19],
    dates: ['2026-05-26', '2026-05-26', '2026-06-25'],
    last_seen: '2026-06-25',
    next_expected: '2026-07-25',
  });

  const may = buildBillMonth({ recurring: [google], month: '2026-05' });
  assert.equal(may.rows.length, 1);
  assert.equal(may.rows[0].providerName, 'Google');
  assert.equal(may.rows[0].paidAmount, 6.38);
  assert.equal(may.rows[0].occurrenceCount, 2);
  assert.equal(may.totals.paidCount, 1);
  assert.equal(may.totals.paid, 6.38);
});

test('a clean car-payment name matches the raw Advancial ACH descriptor', () => {
  const autoLoan = bill({
    providerName: 'Advancial Auto Loan',
    providerKey: 'advancial-auto-loan',
    category: 'Car Payment',
    amountDue: 569.42,
    dueDate: '2026-09-04',
  });
  const rawBankStream = stream({
    payee: 'Advancial Fed Cu DES:Loan Pymt Id:302585 Indn:sifuentes,trey C Co Id:xxxxx88572',
    category: 'Car Payment',
    fixedPrice: true,
    last_amount: 569.42,
    typical_amount: 569.42,
    amounts: [569.42, 569.42, 569.42],
    dates: ['2026-06-05', '2026-07-06', '2026-08-05'],
    last_seen: '2026-08-05',
    next_expected: '2026-09-05',
  });

  assert.equal(obligationProvidersMatch(autoLoan.providerName, rawBankStream.payee), true);

  const upcoming = buildUpcomingObligations({
    bills: [autoLoan], recurring: [rawBankStream], asOf: '2026-08-14',
  });
  assert.equal(upcoming.length, 1, 'raw bank recurrence must not duplicate the tracked car bill');
  assert.equal(upcoming[0].providerName, 'Advancial Auto Loan');
  assert.equal(upcoming[0].dueDate, '2026-09-04');
});

test('a variable utility is marked paid from the provider even when the amount moved a lot', () => {
  const utility = bill({ amountDue: 180, dueDate: '2026-08-05' });
  const utilityStream = stream({
    amounts: [140, 180, 220],
    dates: ['2026-06-05', '2026-07-05', '2026-08-05'],
    last_amount: 220,
    fixedPrice: false,
  });

  const august = buildBillMonth({
    bills: [utility], recurring: [utilityStream], month: '2026-08',
  });
  assert.equal(august.rows.length, 1);
  assert.equal(august.rows[0].paid, true);
  assert.equal(august.rows[0].paidAmount, 220);
  assert.equal(august.rows[0].amountVaries, true);
  assert.equal(august.totals.paid, 220);
});

test('an unpaid tracked bill remains in the month and in paycheck planning', () => {
  const autoLoan = bill({
    providerName: 'Advancial Auto Loan',
    providerKey: 'advancial-auto-loan',
    category: 'Car Payment',
    amountDue: 569.42,
    dueDate: '2026-08-20',
  });

  const august = buildBillMonth({ bills: [autoLoan], month: '2026-08' });
  assert.equal(august.rows.length, 1);
  assert.equal(august.rows[0].paid, false);
  assert.equal(august.totals.remaining, 569.42);

  const upcoming = buildUpcomingObligations({ bills: [autoLoan], asOf: '2026-08-14' });
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0].amountDue, 569.42);
});

test('a bill explicitly marked paid keeps its paid amount even without recurring history', () => {
  const water = bill({
    providerName: 'County Water',
    amountDue: 121.70,
    dueDate: '2026-08-04',
    status: 'paid',
    paidAt: '2026-08-02T15:30:00Z',
    paidAmount: 126.42,
  });

  const august = buildBillMonth({ bills: [water], month: '2026-08' });
  assert.equal(august.rows.length, 1);
  assert.equal(august.rows[0].paid, true);
  assert.equal(august.rows[0].paidDate, '2026-08-02');
  assert.equal(august.rows[0].paidAmount, 126.42);
  assert.equal(august.totals.paid, 126.42);
  assert.equal(august.totals.remaining, 0);
});

test('month navigation projects recurring obligations beyond the immediate next month', () => {
  const google = stream({
    payee: 'Google',
    category: 'Subscriptions',
    kind: 'subscription',
    fixedPrice: true,
    last_amount: 3.19,
    typical_amount: 3.19,
    amounts: [3.19, 3.19],
    dates: ['2026-06-15', '2026-07-15'],
    last_seen: '2026-07-15',
    next_expected: '2026-08-15',
  });

  const october = buildBillMonth({ recurring: [google], month: '2026-10' });
  assert.equal(october.rows.length, 1);
  assert.equal(october.rows[0].paid, false);
  assert.equal(october.rows[0].dueDate, '2026-10-15');
  assert.equal(october.totals.remaining, 3.19);
});

test('shared bill preferences preserve auto/manual and fixed/variable choices', () => {
  const configured = bill({
    raw: { planning: { paymentMode: 'manual', amountMode: 'variable' } },
  });
  assert.deepEqual(billPreferences(configured), {
    paymentMode: 'manual',
    amountMode: 'variable',
  });

  const invalid = bill({ raw: { planning: { paymentMode: 'maybe', amountMode: 'sometimes' } } });
  assert.deepEqual(billPreferences(invalid), { paymentMode: null, amountMode: null });
});
