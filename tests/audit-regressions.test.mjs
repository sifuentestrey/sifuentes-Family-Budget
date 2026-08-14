import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const syncTransactions = readFileSync(new URL('../supabase/functions/sync-transactions/index.ts', import.meta.url), 'utf8');
const billsCenter = readFileSync(new URL('../web/bills-center.js', import.meta.url), 'utf8');
const serviceWorker = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('normal npm test includes both .test.mjs and .test.js regressions', () => {
  assert.match(packageJson.scripts.test, /tests\/\*\.test\.mjs/);
  assert.match(packageJson.scripts.test, /tests\/\*\.test\.js/);
  assert.match(packageJson.scripts.test, /check:syntax/);
});

test('server reprocess window is long enough to see three biweekly paychecks', () => {
  const match = syncTransactions.match(/const REPROCESS_WINDOW_DAYS\s*=\s*(\d+)/);
  assert.ok(match, 'sync function should name its reprocess window');
  assert.ok(Number(match[1]) >= 60, '30-day windows can lose a valid biweekly income stream');
});

test('signed-in refresh path is household scoped rather than scheduler-only', () => {
  assert.match(syncTransactions, /async function authorizedHouseholds/);
  assert.match(syncTransactions, /userClient\.auth\.getUser\(\)/);
  assert.match(syncTransactions, /from\('household_members'\)/);
  assert.match(syncTransactions, /itemQuery\s*=\s*itemQuery\.in\('household_id', households\)/);
  assert.match(syncTransactions, /req\.method === 'OPTIONS'/, 'browser refresh needs CORS preflight support');
});

test('account roster and balances refresh before transaction deltas are mapped', () => {
  assert.match(syncTransactions, /accounts\/get/);
  assert.match(syncTransactions, /current_balance:/);
  assert.match(syncTransactions, /available_balance:/);
  assert.match(syncTransactions, /const accountMap = await refreshAccounts/);
  assert.match(syncTransactions, /unknownAccountIds/);
  assert.match(syncTransactions, /Do not advance the Plaid cursor/);
});

test('income streams are reconciled, not only appended forever', () => {
  assert.match(syncTransactions, /from\('income_streams'\)[\s\S]*?\.delete\(\)[\s\S]*?\.eq\('household_id', householdId\)/);
});

test('Bills is calendar/list based and no longer renders the big left-to-spend hero', () => {
  assert.match(billsCenter, /class=\"bill-calendar\"/);
  assert.match(billsCenter, /Bills & subscriptions/);
  assert.doesNotMatch(billsCenter, /hero-value/);
  assert.doesNotMatch(billsCenter, /bill-progress/);
});

test('Bills uses the device local calendar date and exposes durable deletion', () => {
  assert.match(billsCenter, /function localIsoDate/);
  assert.doesNotMatch(billsCenter, /function todayIso\(\) \{ return new Date\(\)\.toISOString/);
  assert.match(billsCenter, /suppressBill/);
  assert.match(billsCenter, /data-bill-delete/);
});

test('PWA pre-caches the transaction refresh client', () => {
  assert.match(serviceWorker, /refresh-transactions\.js/);
});
