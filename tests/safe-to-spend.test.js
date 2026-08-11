import { describe, expect, it } from 'vitest';
import { calculateSafeToSpend } from '../src/engine/safe-to-spend.js';

describe('calculateSafeToSpend', () => {
  it('reserves known obligations and the household buffer', () => {
    const result = calculateSafeToSpend({
      availableCash: 3000,
      pendingOutflows: [{ amount: 100 }],
      billsDueBeforeForecast: [{ amount: 900 }, { amount: 250 }],
      recurringOutflowsBeforeForecast: [{ amount: 300 }],
      expectedIncomeBeforeForecast: [{ amount: 2500 }],
      savingsCommitments: [{ amount: 200 }],
      buffer: 500,
    });

    expect(result.safeToSpend).toBe(3250);
  });

  it('never reports negative safe-to-spend', () => {
    const result = calculateSafeToSpend({
      availableCash: 100,
      billsDueBeforeForecast: [{ amount: 500 }],
      buffer: 250,
    });

    expect(result.projectedDiscretionary).toBe(-650);
    expect(result.safeToSpend).toBe(0);
    expect(result.constrained).toBe(true);
  });

  it('ignores malformed and negative outflow values instead of making the number unsafe', () => {
    const result = calculateSafeToSpend({
      availableCash: 1000,
      billsDueBeforeForecast: [{ amount: '250' }, { amount: -999 }, { amount: 'not-a-number' }],
      expectedIncomeBeforeForecast: [{ amount: 500 }],
    });

    expect(result.safeToSpend).toBe(1250);
  });
});
