export type PayFrequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
export type EarningsType = 'regular' | 'overtime' | 'callback' | 'standby' | 'holiday' | 'pto' | 'differential' | 'bonus' | 'other';

export interface PayRate { label: string; hourlyRate: number; multiplier?: number; effectiveFrom?: string; }
export interface TimeEntry { date: string; hours: number; earningsType: EarningsType; rateLabel?: string; notes?: string; }
export interface PayPeriod { startDate: string; endDate: string; payDate?: string; }
export interface Deduction { name: string; amount?: number; percentOfGross?: number; preTax?: boolean; }
export interface PayrollProfile {
  employeeLabel: string;
  payFrequency: PayFrequency;
  baseHourlyRate: number;
  overtimeMultiplier: number;
  rates?: PayRate[];
  recurringDeductions?: Deduction[];
  taxWithholdingEstimate?: number;
}
export interface PayEstimate {
  period: PayPeriod;
  regularHours: number;
  overtimeHours: number;
  callbackHours: number;
  standbyHours: number;
  grossPay: number;
  estimatedTaxes: number;
  estimatedDeductions: number;
  estimatedNetPay: number;
  confidence: 'low' | 'medium' | 'high';
}
export interface PayStub { payDate: string; grossPay: number; netPay: number; deductions?: number; source?: string; }
