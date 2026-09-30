/**
 * UKG/timecard import boundary.
 *
 * This is a parser, not a credential scraper. UKG access varies by employer
 * and may require an employer-approved API client; credentials never pass
 * through the browser or enter this repository.
 */

import { makeTimeEntry } from '../domain/payroll.js';

const HEADERS = {
  date: ['date', 'work date', 'shift date', 'business date'],
  regularHours: ['regular hours', 'regular', 'worked hours', 'hours'],
  overtimeHours: ['overtime hours', 'overtime', 'ot hours', 'ot'],
  standbyHours: ['standby hours', 'standby', 'on call hours', 'on-call hours'],
  callbackHours: ['callback hours', 'callback', 'call back hours'],
  callbackEvents: ['callback events', 'callbacks', 'callback count'],
  holidayHours: ['holiday hours', 'holiday'],
  ptoHours: ['pto hours', 'pto', 'vacation hours'],
  differentialCode: ['differential', 'differential code', 'pay code'],
  differentialHours: ['differential hours', 'diff hours'],
};

export function parseUkgCsv(csv, options = {}) {
  const rows = parseCsv(csv);
  if (!rows.length) return [];
  const headers = rows.shift().map(normalizeHeader);
  return rows.map((values, index) => rowFromValues(headers, values, options, index))
    .filter((entry) => entry.date);
}

export function normalizeUkgRows(rows, options = {}) {
  return rows.map((row, index) => {
    const normalized = Object.fromEntries(Object.entries(row)
      .map(([key, value]) => [normalizeHeader(key), value]));
    return rowFromValues(Object.keys(normalized), Object.values(normalized), options, index, normalized);
  }).filter((entry) => entry.date);
}

function rowFromValues(headers, values, options, index, normalized = null) {
  const raw = normalized ?? Object.fromEntries(headers.map((header, i) => [header, values[i]]));
  const value = (field) => first(raw, HEADERS[field].map(normalizeHeader));
  return makeTimeEntry({
    id: options.idPrefix ? `${options.idPrefix}-${index + 1}` : undefined,
    householdId: options.householdId ?? '',
    payProfileId: options.payProfileId,
    date: toIsoDate(value('date')),
    regularHours: number(value('regularHours')),
    overtimeHours: number(value('overtimeHours')),
    standbyHours: number(value('standbyHours')),
    callbackHours: number(value('callbackHours')),
    callbackEvents: number(value('callbackEvents')),
    holidayHours: number(value('holidayHours')),
    ptoHours: number(value('ptoHours')),
    differentialCode: value('differentialCode') || undefined,
    differentialHours: number(value('differentialHours')),
    source: options.source ?? 'timecard_import',
    sourceRef: value('id') || undefined,
  });
}

function parseCsv(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  return lines.map((line) => {
    const cells = [];
    let cell = ''; let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"' && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) { cells.push(cell.trim()); cell = ''; }
      else cell += char;
    }
    cells.push(cell.trim());
    return cells;
  });
}
function first(record, candidates) {
  const key = candidates.find((candidate) => Object.prototype.hasOwnProperty.call(record, candidate));
  return key ? record[key] : undefined;
}
function normalizeHeader(header) {
  return String(header).trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}
function number(value) {
  if (value == null || value === '') return 0;
  const parsed = Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}
function toIsoDate(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const match = raw.match(/^(\d{1,2})[\\/-](\d{1,2})[\\/-](\d{2,4})$/);
  if (!match) return '';
  const [, month, day, year] = match;
  const fullYear = year.length === 2 ? Number(year) + 2000 : Number(year);
  return `${fullYear.toString().padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}
