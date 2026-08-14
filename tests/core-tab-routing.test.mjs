import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const router = readFileSync(new URL('../web/core-tab-router.js', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');

test('primary tab router owns the five bottom-tab destinations by position', () => {
  assert.match(router, /\['dashboard', 'bills', 'spending', 'budget', 'more'\]/);
  assert.match(router, /addEventListener\('click',[\s\S]*true\);/);
  assert.match(router, /stopImmediatePropagation\(\)/);
});

test('shared enhancement links use the same app-owned route bridge', () => {
  assert.match(router, /window\.__familyBudgetRoute = route/);
  assert.match(router, /\.app-bar \[data-view\]/);
});

test('installed PWA ships the routing fix in a fresh cache', () => {
  assert.match(sw, /CACHE_VERSION = 'v44'/);
  assert.match(sw, /'\.\/core-tab-router\.js'/);
  assert.match(sw, /<script src="\.\/core-tab-router\.js"><\/script>/);
});
