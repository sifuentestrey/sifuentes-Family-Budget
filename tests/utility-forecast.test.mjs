import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastUtility, utilityPlanningAmount } from '../src/engine/utility-forecast.js';

const bill = (billDate, amount, source = 'provider_api') => ({
  provider: 'TVEC', utilityType: 'electric', billDate, amount, source,
});

test('uses same-season history for electric when available', () => {
  const bills = [
    bill('2024-08-05', 180), bill('2025-08-05', 220), bill('2026-08-05', 200),
    bill('2026-05-05', 90), bill('2026-06-05', 110),
  ];
  const result = forecastUtility({ provider: 'TVEC', utilityType: 'electric', bills, targetMonth: 8 });
  assert.equal(result.estimatedAmount, 200);
  assert.equal(result.sameMonthSampleSize, 3);
  assert.equal(result.confidence, 'high');
  assert.equal(utilityPlanningAmount(result), 220);
});

test('falls back to recent bills when season history is sparse', () => {
  const bills = [
    bill('2026-04-05', 80, 'transaction_match'),
    bill('2026-05-05', 100, 'manual'),
    bill('2026-06-05', 120, 'pdf_import'),
  ].map((item) => ({ ...item, provider: 'Watermark', utilityType: 'water' }));
  const result = forecastUtility({ provider: 'Watermark', utilityType: 'water', bills, targetMonth: 7 });
  assert.equal(result.estimatedAmount, 100);
  assert.equal(result.sameMonthSampleSize, 0);
  assert.equal(result.interval.low, 90);
  assert.equal(result.interval.high, 110);
  assert.equal(result.confidence, 'medium');
});

test('returns a clear empty state', () => {
  const result = forecastUtility({ provider: 'Watermark', utilityType: 'water', bills: [], targetMonth: 9 });
  assert.equal(result.estimatedAmount, null);
  assert.equal(result.confidence, 'low');
  assert.match(result.reasons[0], /no bill history/i);
});
