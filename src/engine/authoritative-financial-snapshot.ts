/**
 * Single-source-of-truth cash-flow snapshot.
 *
 * UI, Safe-to-Spend, and advisor layers should consume this result instead of
 * independently subtracting balances/bills or re-classifying transactions.
 * This module is pure: callers provide already-normalized facts from Postgres.
 */

export type SnapshotTransaction = {
  id: string;
  accountId: string;
  amount: number;
  date: string;
  pending?: boolean;
  classification: 'spending' | 'income' | 'transfer' | 'credit_card_payment' | 'unknown';
};

export type SnapshotBill = {
  id: string;
  amount: number;
  dueDate: string;
  status: 'upcoming' | 'overdue' | 'paid' | 'unknown';
  confidence: number;
};

export type SnapshotIncome = {
  id: string;
  amount: number;
  expectedDate: string;
  confidence: number;
};

export type FinancialSnapshotInput = {
  asOf: string;
  availableBalance: number;
  transactions: SnapshotTransaction[];
  bills: SnapshotBill[];
  expectedIncome: SnapshotIncome[];
  requiredBuffer: number;
};

export type FinancialSnapshot = {
  asOf: string;
  availableBalance: number;
  pendingSpending: number;
  upcomingBills: number;
  overdueBills: number;
  expectedIncome: number;
  requiredBuffer: number;
  safeToSpend: number;
  confidence: number;
  explanation: string[];
};

function withinWindow(date: string, start: string, end: string): boolean {
  return date >= start && date <= end;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Produces the authoritative cash-flow view for a short planning horizon.
 *
 * Important invariants:
 * - transfers and credit-card payments never count as spending;
 * - pending spending is reserved before safe-to-spend is shown;
 * - only bills inside the horizon are reserved;
 * - expected income is included only when its confidence clears the threshold;
 * - safe-to-spend can never be negative.
 */
export function buildFinancialSnapshot(input: FinancialSnapshotInput): FinancialSnapshot {
  const horizonEnd = addDays(input.asOf, 30);
  const pendingSpending = input.transactions
    .filter(t => t.pending && t.classification === 'spending')
    .reduce((sum, t) => sum + Math.max(0, Math.abs(t.amount)), 0);

  const upcomingBills = input.bills
    .filter(b => b.status !== 'paid' && withinWindow(b.dueDate, input.asOf, horizonEnd))
    .reduce((sum, b) => sum + Math.max(0, b.amount), 0);

  const overdueBills = input.bills
    .filter(b => b.status === 'overdue')
    .reduce((sum, b) => sum + Math.max(0, b.amount), 0);

  const expectedIncome = input.expectedIncome
    .filter(i => i.confidence >= 0.6 && withinWindow(i.expectedDate, input.asOf, horizonEnd))
    .reduce((sum, i) => sum + Math.max(0, i.amount), 0);

  const safeToSpend = Math.max(
    0,
    input.availableBalance
      + expectedIncome
      - pendingSpending
      - upcomingBills
      - overdueBills
      - Math.max(0, input.requiredBuffer),
  );

  const relevantBills = input.bills.filter(b => b.status !== 'paid' && withinWindow(b.dueDate, input.asOf, horizonEnd));
  const billConfidence = relevantBills.length
    ? relevantBills.reduce((sum, b) => sum + Math.min(1, Math.max(0, b.confidence)), 0) / relevantBills.length
    : 1;
  const incomeItems = input.expectedIncome.filter(i => i.confidence >= 0.6 && withinWindow(i.expectedDate, input.asOf, horizonEnd));
  const incomeConfidence = incomeItems.length
    ? incomeItems.reduce((sum, i) => sum + Math.min(1, Math.max(0, i.confidence)), 0) / incomeItems.length
    : 1;

  const confidence = Math.round(((billConfidence * 0.5) + (incomeConfidence * 0.5)) * 100) / 100;
  const explanation = [
    `Starting balance: $${input.availableBalance.toFixed(2)}`,
    `Expected income: $${expectedIncome.toFixed(2)}`,
    `Upcoming bills: $${upcomingBills.toFixed(2)}`,
    `Overdue bills: $${overdueBills.toFixed(2)}`,
    `Pending spending: $${pendingSpending.toFixed(2)}`,
    `Required buffer: $${Math.max(0, input.requiredBuffer).toFixed(2)}`,
  ];

  return {
    asOf: input.asOf,
    availableBalance: input.availableBalance,
    pendingSpending,
    upcomingBills,
    overdueBills,
    expectedIncome,
    requiredBuffer: Math.max(0, input.requiredBuffer),
    safeToSpend,
    confidence,
    explanation,
  };
}
