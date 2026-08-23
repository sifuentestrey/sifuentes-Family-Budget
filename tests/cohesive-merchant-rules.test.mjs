import test from 'node:test';
import assert from 'node:assert/strict';

import { categorizeOne } from '../src/engine/categorize.js';

const ctx = { learned: new Map(), householdRules: [] };

test('obvious fast-food merchants are categorized as Dining Out', () => {
  for (const payee of ['KFC', 'KFC H287005', "Papa John's", 'PAPA JOHNS #214']) {
    assert.deepEqual(
      categorizeOne({ payee, plaidCategory: null }, ctx),
      { category: 'Dining Out', by: 'rule' },
      payee,
    );
  }
});

test('ambiguous merchants still remain for review', () => {
  assert.deepEqual(
    categorizeOne({ payee: 'Chilo Balloon', plaidCategory: null }, ctx),
    { category: null, by: 'none' },
  );
});
