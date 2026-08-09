import { PayEstimate, PayrollProfile, PayPeriod, TimeEntry } from './types';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function estimatePay(
  profile: PayrollProfile,
  period: PayPeriod,
  entries: TimeEntry[],
): PayEstimate {
  const regularHours = entries.filter(e => e.earningsType === 'regular').reduce((s, e) => s + e.hours, 0);
  const overtimeHours = entries.filter(e => e.earningsType === 'overtime').reduce((s, e) => s + e.hours, 0);
  const callbackHours = entries.filter(e => e.earningsType === 'callback').reduce((s, e) => s + e.hours, 0);
  const standbyHours = entries.filter(e => e.earningsType === 'standby').reduce((s, e) => s + e.hours, 0);

  const rateFor = (type: string) => {
    const configured = profile.rates?.find(r => r.label === type);
    if (configured) return configured.hourlyRate * (configured.multiplier ?? 1);
    if (type === 'overtime') return profile.baseHourlyRate * profile.overtimeMultiplier;
    return profile.baseHourlyRate;
  };

  const grossPay = round2(entries.reduce((total, entry) => total + entry.hours * rateFor(entry.rateLabel ?? entry.earningsType), 0));
  const taxRate = Math.max(0, Math.min(1, profile.taxWithholdingEstimate ?? 0));
  const estimatedTaxes = round2(grossPay * taxRate);
  const estimatedDeductions = round2((profile.recurringDeductions ?? []).reduce((total, d) => {
    if (d.amount != null) return total + d.amount;
    return total + grossPay * (d.percentOfGross ?? 0);
  }, 0));

  return {
    period,
    regularHours: round2(regularHours),
    overtimeHours: round2(overtimeHours),
    callbackHours: round2(callbackHours),
    standbyHours: round2(standbyHours),
    grossPay,
    estimatedTaxes,
    estimatedDeductions,
    estimatedNetPay: round2(grossPay - estimatedTaxes - estimatedDeductions),
    confidence: entries.length === 0 ? 'low' : entries.some(e => e.earningsType === 'other') ? 'medium' : 'high',
  };
}

export function compareToActual(estimate: PayEstimate, actualNetPay: number) {
  return {
    estimatedNetPay: estimate.estimatedNetPay,
    actualNetPay: round2(actualNetPay),
    variance: round2(actualNetPay - estimate.estimatedNetPay),
    variancePercent: estimate.estimatedNetPay === 0 ? 0 : round2(((actualNetPay - estimate.estimatedNetPay) / estimate.estimatedNetPay) * 100),
  };
}
