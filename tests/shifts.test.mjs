/**
 * Shift logging: the database mapping, and the wiring that exposes it.
 *
 * The forecast engine itself is covered by payroll.test.mjs. What is new here
 * is the round trip through Postgres column names, which fails silently when it
 * is wrong: the insert succeeds, the column is dropped, and the only symptom is
 * a paycheck estimate that is quietly too low.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  rowToProfile, profileToRow, rowToEntry, entryToRow,
} from '../src/payroll/mapping.js';
import { makePayProfile, makeTimeEntry } from '../src/domain/payroll.js';
import { forecastPaycheck, nextPayPeriod } from '../src/payroll/forecast.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The call-shift profile this feature exists for: 4x10s, so daily overtime is
// disabled, and callouts pay a two-hour minimum per event.
const CALL_PROFILE = makePayProfile({
  label: 'Primary',
  baseHourlyRate: 32,
  dailyOvertimeThreshold: 0,
  weeklyOvertimeThreshold: 40,
  callbackMinimumHours: 2,
  callbackMultiplier: 1.5,
  standbyRate: 3,
  payFrequency: 'biweekly',
  payPeriodStart: '2026-08-02',
  payPeriodEnd: '2026-08-15',
  payday: '2026-08-21',
});

test('a pay profile survives the round trip through database columns', () => {
  const row = profileToRow(CALL_PROFILE, 'hh-1');
  const back = rowToProfile({ ...row, id: 'pp-1', user_id: null });

  for (const key of [
    'baseHourlyRate', 'overtimeMultiplier', 'dailyOvertimeThreshold',
    'weeklyOvertimeThreshold', 'callbackMinimumHours', 'callbackMultiplier',
    'standbyRate', 'payFrequency', 'payPeriodStart', 'payPeriodEnd', 'payday',
  ]) {
    assert.deepEqual(back[key], CALL_PROFILE[key], `${key} did not survive the round trip`);
  }
});

test('a disabled daily overtime threshold stays disabled through the round trip', () => {
  // 0 is falsy, so any `||` in the mapping would silently restore the 8-hour
  // default and manufacture 2 phantom overtime hours on every 10-hour shift.
  const row = profileToRow(CALL_PROFILE, 'hh-1');
  assert.equal(row.daily_overtime_threshold, 0);
  assert.equal(rowToProfile(row).dailyOvertimeThreshold, 0);
});

test('a time entry survives the round trip, including a zero-hour callout', () => {
  const entry = makeTimeEntry({
    date: '2026-08-04',
    regularHours: 10,
    callbackHours: 0.5,
    callbackEvents: 2,
    standbyHours: 12,
  });

  const row = entryToRow(entry, 'hh-1', 'pp-1');
  const back = rowToEntry({ ...row, id: 'te-1' });

  assert.equal(back.date, '2026-08-04');
  assert.equal(back.regularHours, 10);
  assert.equal(back.callbackHours, 0.5);
  assert.equal(back.callbackEvents, 2, 'callout count must not be lost — each earns the minimum');
  assert.equal(back.standbyHours, 12);
});

test('rows written from the app are marked hand-entered', () => {
  // Reconciliation has to be able to tell a typed shift from an imported one.
  const row = entryToRow(makeTimeEntry({ date: '2026-08-04', regularHours: 8 }), 'hh-1', 'pp-1');
  assert.equal(row.source, 'manual');
});

test('numeric columns arriving as strings are coerced', () => {
  // Postgres numeric comes back as a string over PostgREST. Left as strings,
  // the engine would concatenate instead of adding.
  const back = rowToEntry({
    id: 'te-1', entry_date: '2026-08-04',
    regular_hours: '10.00', callback_hours: '0.50', callback_events: 1,
    standby_hours: '12.00', holiday_hours: '0', pto_hours: '0',
    overtime_hours: '0', differential_hours: '0',
  });
  assert.equal(typeof back.regularHours, 'number');
  assert.equal(back.regularHours + back.callbackHours, 10.5);
});

test('logged shifts produce a forecast for the upcoming period', () => {
  const upcoming = nextPayPeriod(CALL_PROFILE, '2026-08-10');
  assert.ok(upcoming, 'a profile with anchor dates must yield an upcoming period');

  const entries = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06']
    .map((date) => makeTimeEntry({ date, regularHours: 10 }));

  const forecast = forecastPaycheck({
    profile: CALL_PROFILE,
    entries,
    period: upcoming.period,
    payDate: upcoming.payDate,
    asOf: '2026-08-10',
  });

  assert.equal(forecast.breakdown.regularHours, 40);
  assert.equal(forecast.breakdown.overtimeHours, 0, '4x10 must not generate daily overtime');
  assert.ok(forecast.estimatedNet > 0);
  assert.ok(forecast.estimatedNet < forecast.breakdown.totalGross, 'net must be below gross');
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const appJs = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
const swJs = readFileSync(join(ROOT, 'web/sw.js'), 'utf8');

test('every nav entry has a renderer', () => {
  // A nav button with no matching renderer throws on click: the view lookup
  // returns undefined and is called immediately.
  //
  // Navigable ids now come from three places. The five primary tabs
  // (NAV_GROUPS); the segmented controls that carry each tab's sibling views
  // (SPENDING_TABS / INCOME_TABS — these replaced the old More menu, which
  // used to be where everything but the tabs lived); and what remains on the
  // More screen, now only the genuinely peripheral destinations.
  const groupsBlock = appJs.match(/const NAV_GROUPS = \[([\s\S]*?)\n\];/)[1];
  const groupIds = [...groupsBlock.matchAll(/id: '([\w-]+)'/g)].map((m) => m[1]);

  const segIds = ['SPENDING_TABS', 'INCOME_TABS'].flatMap((name) => {
    const block = appJs.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`))[1];
    return [...block.matchAll(/\['([\w-]+)',/g)].map((m) => m[1]);
  });

  const moreBlock = appJs.match(/const rows = \[([\s\S]*?)\n  \];/)[1];
  const moreIds = [...moreBlock.matchAll(/\['([\w-]+)',/g)].map((m) => m[1]);

  const navIds = [...new Set([...groupIds, ...segIds, ...moreIds])];
  const registry = appJs.match(/\}\[state\.view\]\(\);/)
    ? appJs.slice(appJs.lastIndexOf('const body =', appJs.indexOf('}[state.view]()')), appJs.indexOf('}[state.view]()'))
    : '';

  assert.ok(navIds.includes('shifts'), 'shifts must be reachable from the nav');
  for (const id of navIds) {
    assert.match(registry, new RegExp(`\\b${id}:\\s*render`), `no renderer wired for "${id}"`);
  }
});

test('every view the app can render is reachable from the nav', () => {
  // The other direction, and the one that actually bit during the nav
  // rebuild: a renderer that no longer appears in any tab, segmented control
  // or More row is dead weight nobody can reach, and the app silently loses a
  // screen. 'review' is the one deliberate exception — it is reached from a
  // banner on Transactions and from Home, not from the nav itself.
  const registry = appJs.slice(
    appJs.lastIndexOf('const body =', appJs.indexOf('}[state.view]()')),
    appJs.indexOf('}[state.view]()'),
  );
  const viewIds = [...registry.matchAll(/^\s{4}([\w-]+):\s*render/gm)].map((m) => m[1]);

  const navSource = [
    appJs.match(/const NAV_GROUPS = \[([\s\S]*?)\n\];/)[1],
    appJs.match(/const SPENDING_TABS = \[([\s\S]*?)\n\];/)[1],
    appJs.match(/const INCOME_TABS = \[([\s\S]*?)\n\];/)[1],
    appJs.match(/const rows = \[([\s\S]*?)\n  \];/)[1],
  ].join('\n');

  for (const id of viewIds) {
    if (id === 'review') continue;
    assert.ok(
      navSource.includes(`'${id}'`),
      `"${id}" has a renderer but nothing in the nav can reach it`,
    );
  }
});

test('the payroll modules the Shifts view needs are cached for offline use', () => {
  for (const mod of [
    '../src/domain/payroll.js',
    '../src/payroll/pay-calculator.js',
    '../src/payroll/forecast.js',
  ]) {
    assert.ok(swJs.includes(mod), `${mod} missing from the service worker shell`);
  }
});

test('adding modules to the shell bumps the cache version', () => {
  // An unchanged version leaves returning users on the old shell, which lacks
  // the new modules — the Shifts view would 404 for exactly the people who
  // already installed the app.
  assert.doesNotMatch(swJs, /CACHE_VERSION = 'v1'/, 'shell changed without a version bump');
});
