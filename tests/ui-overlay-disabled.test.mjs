import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sw = await readFile(new URL('../web/sw.js', import.meta.url), 'utf8');

const retiredOverlays = [
  'simple-finance-shell.js',
  'core-tab-router.js',
  'simple-home.js',
  'simple-budget.js',
  'money-plan-ui.js',
];

test('production shell does not inject the retired redesign overlay stack', () => {
  for (const file of retiredOverlays) {
    assert.equal(sw.includes(`'./${file}'`), false, `${file} must not be precached by the production shell`);
    assert.equal(sw.includes(`refreshed.includes('${file}')`), false, `${file} must not be injected into page navigations`);
  }
});

test('stable Bills/calendar enhancements remain enabled', () => {
  assert.match(sw, /budget-clarity\.js/);
  assert.match(sw, /payday-calendar\.js/);
});
