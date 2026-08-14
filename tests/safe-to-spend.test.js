import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateSafeToSpend } from '../src/engine/safe-to-spend.js';

test('reserves known obligations and the household buffer', () => {
  const result = calculateSafeToSpend({
    availableCash: 3000,
    pendingOutflows: [{ amount: 100 }],
    billsDueBeforeForecast: [{ amount: 900 }, { amount: 250 }],
    recurringOutflowsBeforeForecast: [{ amount: 300 }],
    expectedIncomeBeforeForecast: [{ amount: 2500 }],
    savingsCommitments: [{ amount: 200 }],
    buffer: 500,
  });

  assert.equal(result.safeToSpend, 3250);
});

test('never reports negative safe-to-spend', () => {
  const result = calculateSafeToSpend({
    availableCash: 100,
    billsDueBeforeForecast: [{ amount: 500 }],
    buffer: 250,
  });

  assert.equal(result.projectedDiscretionary, -650);
  assert.equal(result.safeToSpend, 0);
  assert.equal(result.constrained, true);
});

test('ignores malformed and negative outflow values instead of making the number unsafe', () => {
  const result = calculateSafeToSpend({
    availableCash: 1000,
    billsDueBeforeForecast: [{ amount: '250' }, { amount: -999 }, { amount: 'not-a-number' }],
    expectedIncomeBeforeForecast: [{ amount: 500 }],
  });

  assert.equal(result.safeToSpend, 1250);
});
