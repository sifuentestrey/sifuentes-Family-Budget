/**
 * Read-only UKG payroll adapter.
 *
 * UKG tenants expose different WFM/HCM products and endpoint shapes. This
 * adapter deliberately does not guess a login flow or scrape the employee UI:
 * the caller supplies the tenant endpoints and a runtime session store.
 *
 * The session store is intentionally tiny. Production should back it with an
 * encrypted server-side/session runtime, never a database column, localStorage,
 * source control, or a browser bundle.
 *
 * @module ukg-payroll-provider
 */

import { makePaystub, makeTimeEntry } from '../../domain/payroll.js';

const DEFAULT_HEADERS = { accept: 'application/json' };
const asArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {{timecard: string|((period: object) => string), paystubs: string|((opts: object) => string), health?: string|((input: object) => string)}} options.endpoints
 * @param {{request: (input: object) => Promise<object>}} options.transport
 * @param {{get: () => Promise<string|null>|(string|null)}} options.sessionStore
 * @param {string} [options.householdId]
 * @param {string} [options.payProfileId]
 */
export function createUkgPayrollProvider(options) {
  const {
    baseUrl = '',
    endpoints,
    transport,
    sessionStore,
    householdId = '',
    payProfileId,
  } = options ?? {};

  if (!endpoints?.timecard || !endpoints?.paystubs) {
    throw new Error('UKG endpoints.timecard and endpoints.paystubs are required');
  }
  if (typeof transport?.request !== 'function') {
    throw new Error('UKG transport.request is required');
  }
  if (typeof sessionStore?.get !== 'function') {
    throw new Error('UKG sessionStore.get is required');
  }

  const sessionCookie = async () => {
    const cookie = await sessionStore.get();
    return cookie ? { cookie } : {};
  };

  const request = async (path, query = {}) => {
    const response = await transport.request({
      method: 'GET',
      url: new URL(resolvePath(path, query), baseUrl || 'http://ukg.invalid').toString(),
      headers: { ...DEFAULT_HEADERS, ...(await sessionCookie()) },
      query,
    });
    if (response?.status && response.status >= 400) {
      throw new Error(`UKG request failed (${response.status})`);
    }
    return response?.data ?? response;
  };

  return {
    info: {
      key: 'ukg',
      displayName: 'UKG',
      kind: 'payroll',
      isLive: true,
      authType: 'session',
    },
    capabilities: { incremental: true, minIntervalMinutes: 30 },

    async isConnected() {
      const cookie = await sessionStore.get();
      if (!cookie) return false;
      if (!endpoints.health) return true;
      try {
        await request(endpoints.health);
        return true;
      } catch {
        return false;
      }
    },

    async getTimecard(period) {
      const payload = await request(endpoints.timecard, period);
      return extractRows(payload, ['timecard', 'timecards', 'timeEntries', 'entries', 'data'])
        .map((row) => normalizeTimeEntry(row, { householdId, payProfileId }));
    },

    async getPaystubs(opts = {}) {
      const payload = await request(endpoints.paystubs, opts);
      return extractRows(payload, ['paystubs', 'payStatements', 'statements', 'data'])
        .map((row) => normalizePaystub(row, { householdId, payProfileId }));
    },
  };
}

export function normalizeTimeEntry(row, context = {}) {
  const regularHours = number(row, ['regularHours', 'regular_hours', 'hours', 'workedHours']);
  const overtimeHours = number(row, ['overtimeHours', 'overtime_hours', 'otHours', 'overtime']);
  const standbyHours = number(row, ['standbyHours', 'standby_hours', 'onCallHours', 'on_call_hours']);
  const callbackHours = number(row, ['callbackHours', 'callback_hours', 'callBackHours', 'calloutHours']);
  const callbackEvents = number(row, ['callbackEvents', 'callback_events', 'calloutEvents']) ||
    (callbackHours > 0 ? 1 : 0);

  return makeTimeEntry({
    ...context,
    date: value(row, ['date', 'entryDate', 'entry_date', 'workDate', 'shiftDate']),
    startTime: value(row, ['startTime', 'start_time', 'inTime', 'clockIn']),
    endTime: value(row, ['endTime', 'end_time', 'outTime', 'clockOut']),
    regularHours,
    overtimeHours,
    standbyHours,
    callbackHours,
    callbackEvents,
    holidayHours: number(row, ['holidayHours', 'holiday_hours', 'holiday']),
    ptoHours: number(row, ['ptoHours', 'pto_hours', 'paidTimeOffHours', 'vacationHours']),
    differentialCode: value(row, ['differentialCode', 'differential_code', 'premiumCode', 'shiftCode']),
    differentialHours: number(row, ['differentialHours', 'differential_hours', 'premiumHours']),
    notes: value(row, ['notes', 'note', 'comments']),
    source: 'provider_api',
    sourceRef: String(value(row, ['id', 'entryId', 'entry_id', 'recordId', 'record_id']) ?? ''),
  });
}

export function normalizePaystub(row, context = {}) {
  const periodStart = value(row, ['periodStart', 'period_start', 'payPeriodStart', 'pay_period_start']);
  const periodEnd = value(row, ['periodEnd', 'period_end', 'payPeriodEnd', 'pay_period_end']);
  const earnings = objectValue(row, ['earnings', 'earningLines', 'earning_lines', 'payComponents']);
  const deductions = asArray(value(row, ['deductions', 'deductionLines', 'deduction_lines']))
    .map((d) => ({
      label: String(value(d, ['label', 'name', 'description', 'code']) ?? 'Deduction'),
      amount: number(d, ['amount', 'value']),
      preTax: Boolean(value(d, ['preTax', 'pre_tax'])),
    }));

  return makePaystub({
    ...context,
    payDate: value(row, ['payDate', 'pay_date', 'checkDate', 'check_date']),
    period: { start: periodStart, end: periodEnd },
    grossPay: number(row, ['grossPay', 'gross_pay', 'gross']),
    netPay: number(row, ['netPay', 'net_pay', 'net']),
    totalTaxes: number(row, ['totalTaxes', 'total_taxes', 'taxes', 'withholding']),
    regularHours: number(row, ['regularHours', 'regular_hours']),
    overtimeHours: number(row, ['overtimeHours', 'overtime_hours', 'otHours']),
    deductions,
    earnings,
    source: 'provider_api',
    sourceRef: String(value(row, ['id', 'paystubId', 'paystub_id', 'statementId', 'statement_id']) ?? ''),
    confidence: 1,
  });
}

function extractRows(payload, keys) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return payload && typeof payload === 'object' ? [payload] : [];
}

function value(row, keys) {
  for (const key of keys) {
    if (row?.[key] !== undefined && row?.[key] !== null && row[key] !== '') return row[key];
  }
  return undefined;
}

function number(row, keys) {
  const raw = value(row, keys);
  const parsed = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function objectValue(row, keys) {
  const raw = value(row, keys);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

function resolvePath(path, query) {
  return typeof path === 'function' ? path(query) : path;
}
