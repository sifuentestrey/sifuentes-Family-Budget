import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUkgCsv } from '../src/ingestion/ukg-timecard.js';

test('normalizes a UKG-style CSV into payroll time entries', () => {
  const csv = [
    'Work Date,Regular Hours,OT Hours,Standby Hours,Callback Hours,Callback Events,Pay Code',
    '08/10/2026,10,0,12,0,0,day',
    '08/11/2026,10,2,0,0.5,1,night',
  ].join('\n');
  const entries = parseUkgCsv(csv, { idPrefix: 'ukg' });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].date, '2026-08-10');
  assert.equal(entries[1].overtimeHours, 2);
  assert.equal(entries[1].callbackEvents, 1);
  assert.equal(entries[1].source, 'timecard_import');
});
