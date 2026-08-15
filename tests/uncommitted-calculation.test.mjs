import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');

test('until-payday money does not deduct an unfunded three-month emergency goal', () => {
  const start = app.indexOf('function gatherSafeToSpendInputs()');
  const end = app.indexOf('function buildPlan()', start);
  const gather = app.slice(start, end);
  assert.match(gather, /const bufferTarget = 0;/);
  assert.doesNotMatch(gather, /monthly\?\.necessary.*\* 3/);
});

test('household UI calls the result uncommitted rather than safe/free to spend', () => {
  assert.match(app, /Uncommitted until/);
  assert.match(app, />Uncommitted<\/span>/);
});

test('installed app receives the corrected calculation', () => {
  assert.match(sw, /CACHE_VERSION = 'v47'/);
});
