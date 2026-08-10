/**
 * Translation between payroll domain objects and their database rows.
 *
 * Pure and dependency-free on purpose. The obvious home for this is the browser
 * module that does the querying, but that module imports the Supabase client
 * from a CDN and therefore cannot be loaded in a test runner. A wrong column
 * name here fails silently — the insert succeeds, the field is quietly dropped,
 * and the forecast is subtly wrong forever — so this is exactly the code that
 * needs a round-trip test, and it lives here to get one.
 */

const n = (v) => (v == null ? 0 : Number(v));

export function rowToProfile(row) {
  return {
    id: row.id,
    householdId: row.household_id,
    userId: row.user_id,
    label: row.label,
    employerName: row.employer_name ?? undefined,
    baseHourlyRate: n(row.base_hourly_rate),
    overtimeMultiplier: n(row.overtime_multiplier),
    doubleTimeMultiplier: n(row.double_time_multiplier),
    dailyOvertimeThreshold: n(row.daily_overtime_threshold),
    weeklyOvertimeThreshold: n(row.weekly_overtime_threshold),
    standbyRate: n(row.standby_rate),
    standbyIsDaily: row.standby_is_daily ?? false,
    callbackMinimumHours: n(row.callback_minimum_hours),
    callbackMultiplier: n(row.callback_multiplier),
    holidayMultiplier: n(row.holiday_multiplier),
    differentialRates: row.differential_rates ?? {},
    recurringDeductions: row.recurring_deductions ?? [],
    taxAssumptions: row.tax_assumptions ?? {},
    payFrequency: row.pay_frequency,
    payPeriodStart: row.pay_period_start ?? '',
    payPeriodEnd: row.pay_period_end ?? '',
    payday: row.payday ?? '',
    paydayLagDays: row.payday_lag_days ?? undefined,
  };
}

export function profileToRow(profile, householdId) {
  return {
    household_id: householdId,
    label: profile.label,
    employer_name: profile.employerName || null,
    base_hourly_rate: profile.baseHourlyRate,
    overtime_multiplier: profile.overtimeMultiplier,
    double_time_multiplier: profile.doubleTimeMultiplier,
    daily_overtime_threshold: profile.dailyOvertimeThreshold,
    weekly_overtime_threshold: profile.weeklyOvertimeThreshold,
    standby_rate: profile.standbyRate,
    standby_is_daily: profile.standbyIsDaily,
    callback_minimum_hours: profile.callbackMinimumHours,
    callback_multiplier: profile.callbackMultiplier,
    holiday_multiplier: profile.holidayMultiplier,
    differential_rates: profile.differentialRates,
    recurring_deductions: profile.recurringDeductions,
    tax_assumptions: profile.taxAssumptions,
    pay_frequency: profile.payFrequency,
    pay_period_start: profile.payPeriodStart || null,
    pay_period_end: profile.payPeriodEnd || null,
    payday: profile.payday || null,
    payday_lag_days: profile.paydayLagDays ?? null,
  };
}

export function stubToRow(stub, householdId) {
  return {
    household_id: householdId,
    pay_profile_id: stub.payProfileId ?? null,
    pay_date: stub.payDate,
    period_start: stub.period?.start ?? null,
    period_end: stub.period?.end ?? null,
    gross_pay: stub.grossPay,
    net_pay: stub.netPay,
    total_taxes: stub.totalTaxes,
    regular_hours: stub.regularHours ?? null,
    overtime_hours: stub.overtimeHours ?? null,
    earnings: stub.earnings ?? {},
    source: stub.source,
    source_ref: stub.sourceRef ?? null,
    confidence: stub.confidence,
  };
}

export function rowToStub(row, deductionRows = []) {
  return {
    id: row.id,
    householdId: row.household_id,
    payProfileId: row.pay_profile_id ?? undefined,
    payDate: row.pay_date,
    period: { start: row.period_start, end: row.period_end },
    grossPay: n(row.gross_pay),
    netPay: n(row.net_pay),
    regularHours: row.regular_hours != null ? n(row.regular_hours) : undefined,
    overtimeHours: row.overtime_hours != null ? n(row.overtime_hours) : undefined,
    totalTaxes: n(row.total_taxes),
    deductions: deductionRows.map(rowToDeduction),
    earnings: row.earnings ?? {},
    source: row.source,
    sourceRef: row.source_ref ?? undefined,
    confidence: n(row.confidence),
  };
}

export function deductionToRow(deduction, householdId, paystubId) {
  return {
    household_id: householdId,
    paystub_id: paystubId,
    label: deduction.label,
    amount: deduction.amount,
    pre_tax: deduction.preTax ?? false,
    category: deduction.category ?? null,
  };
}

export function rowToDeduction(row) {
  return {
    label: row.label,
    amount: n(row.amount),
    preTax: row.pre_tax ?? false,
  };
}

export function reconciliationToRow(reconciliation, householdId, forecastId) {
  return {
    household_id: householdId,
    paystub_id: reconciliation.paystubId,
    forecast_id: forecastId ?? null,
    expected_gross: reconciliation.gross.expected,
    actual_gross: reconciliation.gross.actual,
    expected_net: reconciliation.net.expected,
    actual_net: reconciliation.net.actual,
    expected_taxes: reconciliation.taxes.expected,
    actual_taxes: reconciliation.taxes.actual,
    expected_deductions: reconciliation.deductions.expected,
    actual_deductions: reconciliation.deductions.actual,
    material_variance: reconciliation.materialVariance,
    findings: reconciliation.findings,
    derived_rates: reconciliation.derivedRates,
  };
}

export function rowToReconciliationSummary(row) {
  return {
    id: row.id,
    paystubId: row.paystub_id,
    expectedGross: n(row.expected_gross),
    actualGross: n(row.actual_gross),
    expectedNet: n(row.expected_net),
    actualNet: n(row.actual_net),
    expectedTaxes: n(row.expected_taxes),
    actualTaxes: n(row.actual_taxes),
    expectedDeductions: n(row.expected_deductions),
    actualDeductions: n(row.actual_deductions),
    materialVariance: row.material_variance,
    findings: row.findings ?? [],
    derivedRates: row.derived_rates ?? {},
    createdAt: row.created_at,
  };
}

export function rowToEntry(row) {
  return {
    id: row.id,
    householdId: row.household_id,
    payProfileId: row.pay_profile_id,
    date: row.entry_date,
    startTime: row.start_time ?? undefined,
    endTime: row.end_time ?? undefined,
    regularHours: n(row.regular_hours),
    overtimeHours: n(row.overtime_hours),
    standbyHours: n(row.standby_hours),
    callbackHours: n(row.callback_hours),
    callbackEvents: row.callback_events ?? 0,
    holidayHours: n(row.holiday_hours),
    ptoHours: n(row.pto_hours),
    differentialCode: row.differential_code ?? undefined,
    differentialHours: n(row.differential_hours),
    notes: row.notes ?? undefined,
    source: row.source ?? 'manual',
  };
}

export function entryToRow(entry, householdId, payProfileId) {
  return {
    household_id: householdId,
    pay_profile_id: payProfileId,
    entry_date: entry.date,
    start_time: entry.startTime || null,
    end_time: entry.endTime || null,
    regular_hours: entry.regularHours,
    overtime_hours: entry.overtimeHours,
    standby_hours: entry.standbyHours,
    callback_hours: entry.callbackHours,
    callback_events: entry.callbackEvents,
    holiday_hours: entry.holidayHours,
    pto_hours: entry.ptoHours,
    differential_code: entry.differentialCode || null,
    differential_hours: entry.differentialHours ?? 0,
    notes: entry.notes || null,
    // Rows written from this app are always hand-entered. Provider imports set
    // their own source so reconciliation can tell them apart.
    source: 'manual',
  };
}
