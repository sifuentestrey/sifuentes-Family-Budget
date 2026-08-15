/**
 * Payroll domain models: TimeEntry, PayProfile, Paystub.
 *
 * Built for irregular schedules first, because that is what this household
 * actually has. Two assumptions that most payroll code bakes in are wrong here
 * and are therefore configurable:
 *
 *   1. **Overtime is not "hours over 8 in a day".** On a 4x10 schedule every
 *      single shift is 10 hours, so a fixed 8-hour daily threshold manufactures
 *      2 hours of phantom overtime per day — about 8 hours a week of pay that
 *      does not exist. The daily threshold is a field, and for 4x10 it is
 *      normally 10 or simply disabled in favour of the weekly threshold.
 *
 *   2. **A callback is not paid by the minute.** Being called back after hours
 *      almost always pays a contractual minimum — commonly 2 to 4 hours —
 *      regardless of how long the work took. A 30-minute callback that pays
 *      2 hours is the normal case, not an edge case.
 *
 * Standby (being on call without working) is usually a flat rate per day or
 * per week rather than an hourly wage, so it is modeled separately from hours.
 */

/** @typedef {'weekly'|'biweekly'|'semimonthly'|'monthly'} PayFrequency */
/** @typedef {'manual'|'timecard_import'|'provider_api'|'estimated'} TimeEntrySource */

export const PAY_FREQUENCIES = /** @type {PayFrequency[]} */ ([
  'weekly', 'biweekly', 'semimonthly', 'monthly',
]);

/**
 * @typedef {object} TimeEntry
 * @property {string} id
 * @property {string} householdId
 * @property {string} [payProfileId]
 * @property {string} date              - ISO date
 * @property {string} [startTime]       - "HH:MM" local
 * @property {string} [endTime]
 * @property {number} regularHours
 * @property {number} overtimeHours     - only when the employer reports it directly
 * @property {number} standbyHours      - hours ON CALL, not worked
 * @property {number} callbackHours     - actual hours worked on a callback
 * @property {number} callbackEvents    - distinct callbacks; each earns the minimum
 * @property {number} holidayHours
 * @property {number} ptoHours
 * @property {string} [differentialCode] - e.g. "night", "swing"
 * @property {number} [differentialHours]
 * @property {string} [notes]
 * @property {TimeEntrySource} source
 * @property {string} [sourceRef]        - provider row id, for dedupe
 */

/**
 * @param {Partial<TimeEntry>} input
 * @returns {TimeEntry}
 */
export function makeTimeEntry(input) {
  return {
    id: input.id ?? randomId('te'),
    householdId: input.householdId ?? '',
    payProfileId: input.payProfileId,
    date: input.date ?? '',
    startTime: input.startTime,
    endTime: input.endTime,
    regularHours: num(input.regularHours),
    overtimeHours: num(input.overtimeHours),
    standbyHours: num(input.standbyHours),
    callbackHours: num(input.callbackHours),
    // Defaults to 1 when callback hours exist but no count was given — a
    // callback with hours logged happened at least once.
    callbackEvents: input.callbackEvents ?? (num(input.callbackHours) > 0 ? 1 : 0),
    holidayHours: num(input.holidayHours),
    ptoHours: num(input.ptoHours),
    differentialCode: input.differentialCode,
    differentialHours: num(input.differentialHours),
    notes: input.notes,
    source: input.source ?? 'manual',
    sourceRef: input.sourceRef,
  };
}

export function validateTimeEntry(entry) {
  const errors = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) errors.push('date must be ISO (YYYY-MM-DD)');

  for (const field of [
    'regularHours', 'overtimeHours', 'standbyHours',
    'callbackHours', 'holidayHours', 'ptoHours',
  ]) {
    if (entry[field] < 0) errors.push(`${field} must not be negative`);
  }

  // Standby is time on call, not time worked, so it legitimately overlaps a
  // 24-hour day alongside worked hours. Only WORKED hours are capped.
  const worked = entry.regularHours + entry.overtimeHours + entry.callbackHours
    + entry.holidayHours + entry.ptoHours;
  if (worked > 24) errors.push(`worked hours (${worked}) exceed 24 in one day`);

  if (entry.callbackHours > 0 && entry.callbackEvents < 1) {
    errors.push('callbackHours present but callbackEvents is 0');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * @typedef {object} RecurringDeduction
 * @property {string} label
 * @property {number} amount            - per pay period, or percent when isPercent
 * @property {boolean} [isPercent]
 * @property {boolean} [preTax]         - reduces taxable gross
 */

/**
 * @typedef {object} TaxAssumptions
 * @property {number} federalRate       - 0..1 effective rate, not marginal
 * @property {number} stateRate
 * @property {number} socialSecurityRate
 * @property {number} medicareRate
 * @property {number} [additionalFlat]  - per period
 */

/**
 * @typedef {object} PayProfile
 * @property {string} id
 * @property {string} householdId
 * @property {string} [userId]
 * @property {string} label             - "Alex — Northstar Logistics"
 * @property {string} [employerName]
 * @property {number} baseHourlyRate
 * @property {number} overtimeMultiplier
 * @property {number} [doubleTimeMultiplier]
 * @property {number} [dailyOvertimeThreshold] - null/0 disables daily OT (4x10)
 * @property {number} weeklyOvertimeThreshold
 * @property {number} standbyRate              - per standby hour, or per day if standbyIsDaily
 * @property {boolean} [standbyIsDaily]
 * @property {number} callbackMinimumHours     - paid minimum per callback event
 * @property {number} callbackMultiplier       - usually 1.5 or 2.0
 * @property {number} holidayMultiplier
 * @property {Record<string, number>} [differentialRates] - code -> extra $/hr
 * @property {RecurringDeduction[]} recurringDeductions
 * @property {TaxAssumptions} taxAssumptions
 * @property {PayFrequency} payFrequency
 * @property {string} payPeriodStart    - ISO date of a known period start
 * @property {string} payPeriodEnd
 * @property {string} payday            - ISO date of the payday for that period
 * @property {number} [paydayLagDays]   - days between period end and payday
 */

/**
 * Defaults are intentionally neutral, not tuned to any employer.
 * `dailyOvertimeThreshold: 0` means "no daily OT" — the safe default, because
 * inventing a threshold produces phantom overtime on any compressed schedule.
 *
 * @param {Partial<PayProfile>} input
 * @returns {PayProfile}
 */
export function makePayProfile(input) {
  return {
    id: input.id ?? randomId('pp'),
    householdId: input.householdId ?? '',
    userId: input.userId,
    label: input.label ?? 'Primary',
    employerName: input.employerName,
    baseHourlyRate: num(input.baseHourlyRate),
    overtimeMultiplier: input.overtimeMultiplier ?? 1.5,
    doubleTimeMultiplier: input.doubleTimeMultiplier ?? 2.0,
    dailyOvertimeThreshold: input.dailyOvertimeThreshold ?? 0,
    weeklyOvertimeThreshold: input.weeklyOvertimeThreshold ?? 40,
    standbyRate: num(input.standbyRate),
    standbyIsDaily: input.standbyIsDaily ?? false,
    callbackMinimumHours: input.callbackMinimumHours ?? 0,
    callbackMultiplier: input.callbackMultiplier ?? 1.5,
    holidayMultiplier: input.holidayMultiplier ?? 1.5,
    differentialRates: input.differentialRates ?? {},
    recurringDeductions: input.recurringDeductions ?? [],
    taxAssumptions: input.taxAssumptions ?? {
      federalRate: 0, stateRate: 0, socialSecurityRate: 0.062, medicareRate: 0.0145,
    },
    payFrequency: input.payFrequency ?? 'biweekly',
    payPeriodStart: input.payPeriodStart ?? '',
    payPeriodEnd: input.payPeriodEnd ?? '',
    payday: input.payday ?? '',
    paydayLagDays: input.paydayLagDays,
  };
}

export function validatePayProfile(profile) {
  const errors = [];
  if (profile.baseHourlyRate <= 0) errors.push('baseHourlyRate must be positive');
  if (profile.overtimeMultiplier < 1) errors.push('overtimeMultiplier must be >= 1');
  if (!PAY_FREQUENCIES.includes(profile.payFrequency)) {
    errors.push(`unknown payFrequency: ${profile.payFrequency}`);
  }
  if (profile.callbackMinimumHours < 0) errors.push('callbackMinimumHours must not be negative');

  const t = profile.taxAssumptions;
  const total = t.federalRate + t.stateRate + t.socialSecurityRate + t.medicareRate;
  if (total >= 1) errors.push('tax rates sum to >= 100%');
  for (const [key, rate] of Object.entries(t)) {
    if (key !== 'additionalFlat' && (rate < 0 || rate > 1)) {
      errors.push(`${key} must be a rate between 0 and 1, not a percentage`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * @typedef {object} PaystubDeduction
 * @property {string} label
 * @property {number} amount
 * @property {boolean} [preTax]
 */

/**
 * @typedef {object} Paystub
 * @property {string} id
 * @property {string} householdId
 * @property {string} [payProfileId]
 * @property {string} payDate
 * @property {{start: string, end: string}} period
 * @property {number} grossPay
 * @property {number} netPay
 * @property {number} [regularHours]
 * @property {number} [overtimeHours]
 * @property {number} totalTaxes
 * @property {PaystubDeduction[]} deductions
 * @property {Record<string, number>} [earnings] - line items by label
 * @property {Record<string, unknown>} [metadata] - check/advice number, employer, rate, PTO, YTD totals
 * @property {'manual'|'pdf'|'provider_api'|'email'} source
 * @property {string} [sourceRef]                - for dedupe
 * @property {number} confidence
 */

export function makePaystub(input) {
  return {
    id: input.id ?? randomId('ps'),
    householdId: input.householdId ?? '',
    payProfileId: input.payProfileId,
    payDate: input.payDate ?? '',
    period: input.period ?? { start: '', end: '' },
    grossPay: num(input.grossPay),
    netPay: num(input.netPay),
    regularHours: input.regularHours,
    overtimeHours: input.overtimeHours,
    totalTaxes: num(input.totalTaxes),
    deductions: input.deductions ?? [],
    earnings: input.earnings ?? {},
    metadata: input.metadata ?? {},
    source: input.source ?? 'manual',
    sourceRef: input.sourceRef,
    confidence: input.confidence ?? (input.source === 'manual' ? 1 : 0),
  };
}

export function validatePaystub(stub) {
  const errors = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stub.payDate)) errors.push('payDate must be ISO');
  if (stub.grossPay < 0) errors.push('grossPay must not be negative');
  if (stub.netPay > stub.grossPay) errors.push('netPay exceeds grossPay');
  return { valid: errors.length === 0, errors };
}

function num(value) {
  return typeof value === 'number' && !Number.isNaN(value) ? value : 0;
}

function randomId(prefix) {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
