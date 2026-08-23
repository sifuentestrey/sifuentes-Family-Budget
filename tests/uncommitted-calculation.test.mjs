import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const home = readFileSync(new URL('../web/simple-home.js', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');

test('legacy until-payday calculation does not deduct an unfunded three-month emergency goal', () => {
  const start = app.indexOf('function gatherSafeToSpendInputs()');
  const end = app.indexOf('function buildPlan()', start);
  const gather = app.slice(start, end);
  assert.match(gather, /const bufferTarget = 0;/);
  assert.doesNotMatch(gather, /monthly\?\.necessary.*\* 3/);
});

test('home uses plain checking and payday language, not legacy spending headlines', () => {
  assert.match(home, /Checking now/);
  assert.match(home, /Until payday/);
  assert.doesNotMatch(app, /Uncommitted until/i);
  assert.doesNotMatch(app, /Safe to spend/i);
  assert.doesNotMatch(home, /safe to spend|uncommitted/i);
});

test('installed app receives the household-plan home shell', () => {
  assert.match(sw, /CACHE_VERSION = 'v55'/);
  assert.match(home, /buildHouseholdPlan/);
});
