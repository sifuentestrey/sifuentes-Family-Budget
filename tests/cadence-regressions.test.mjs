import test from 'node:test';
import assert from 'node:assert/strict';

import { inferCadence, projectNext, addMonths } from '../src/engine/cadence.js';

test('mortgage payments a few days around the month boundary are still monthly', () => {
  // Real-world shape: paid May 26, Jun 29, Aug 3. The contractual due date may
  // be the 1st even though the bank posting dates drift several days.
  assert.equal(
    inferCadence(['2026-05-26', '2026-06-29', '2026-08-03']),
    'monthly',
  );
});

test('monthly projection uses calendar months instead of adding 30 days', () => {
  assert.equal(projectNext('2026-08-03', 'monthly'), '2026-09-03');
  assert.equal(projectNext('2026-09-03', 'monthly'), '2026-10-03');
});

test('calendar-month projection clamps end-of-month dates safely', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
});

test('quarterly cadence is recognized and projected by three calendar months', () => {
  assert.equal(
    inferCadence(['2026-01-01', '2026-04-01', '2026-07-01']),
    'quarterly',
  );
  assert.equal(projectNext('2026-07-01', 'quarterly'), '2026-10-01');
});
