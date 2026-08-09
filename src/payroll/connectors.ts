import { PayStub, PayPeriod, TimeEntry } from './types';

export interface TimecardConnector {
  provider: string;
  getTimeEntries(period: PayPeriod): Promise<TimeEntry[]>;
}

export interface PaystubConnector {
  provider: string;
  getLatestPayStub(): Promise<PayStub | null>;
}

/**
 * Implementations should use an official API/OAuth connection when the employer
 * or payroll provider supports one. Do not store raw payroll passwords in this app.
 */
export interface PayrollConnector extends TimecardConnector, PaystubConnector {}

export class NotConfiguredPayrollConnector implements PayrollConnector {
  provider = 'not-configured';
  async getTimeEntries(_period: PayPeriod): Promise<TimeEntry[]> { return []; }
  async getLatestPayStub(): Promise<PayStub | null> { return null; }
}
