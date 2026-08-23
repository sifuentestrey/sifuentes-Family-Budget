import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const reset = readFileSync(new URL('../web/reset.html', import.meta.url), 'utf8');

test('returning users keep navigation while real data hydrates', () => {
  const boot = app.slice(app.indexOf('if (state.bootLoading) {'), app.indexOf('const body = {'));
  assert.match(boot, /renderBottomNav\(\)/);
  assert.match(boot, /data-view/);
  assert.match(boot, /Updating your numbers/);
});

test('dashboard waits for its month instead of throwing during auth startup', () => {
  const dashboard = app.slice(app.indexOf('function renderDashboard()'), app.indexOf('function renderHouseholdPrompt()'));
  assert.match(dashboard, /if \(!state\.month\)/);
  assert.ok(dashboard.indexOf('if (!state.month)') < dashboard.indexOf("state.month.split('-')"));
});

test('bills and targets do not block the first real-data paint', () => {
  const start = app.lastIndexOf('(async () => {');
  const startup = app.slice(start);
  assert.ok(startup.indexOf('state.bootLoading = false') < startup.indexOf('refreshBills().then(render)'));
  assert.doesNotMatch(startup, /await refreshBills\(\)/);
});

test('PWA install caches only the critical shell instead of the whole engine graph', () => {
  const shell = sw.slice(sw.indexOf('const SHELL_ASSETS'), sw.indexOf('self.addEventListener'));
  assert.match(sw, /CACHE_VERSION = 'v55'/);
  assert.doesNotMatch(shell, /\.\.\/src\/engine\//);
  assert.match(shell, /refresh-transactions\.js/);
  assert.match(shell, /payroll\/forecast\.js/);
});

test('old service-worker overlays can be escaped without waiting for the app', () => {
  assert.match(index, /retired-overlay-sentinels/);
  assert.match(index, /updateViaCache: 'none'/);
  assert.match(index, /controllerchange/);
  assert.match(index, /registration\.update\(\)/);
  assert.match(reset, /getRegistrations\(\)/);
  assert.match(reset, /key\.startsWith\('budget-'\)/);
  assert.match(reset, /location\.replace/);
});