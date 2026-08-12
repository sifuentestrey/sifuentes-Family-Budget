import { describe, expect, it } from 'vitest';
import { buildFinancialSnapshot } from './authoritative-financial-snapshot';

describe('buildFinancialSnapshot', () => {
  it('uses one consistent formula for safe-to-spend', () => {
    const result = buildFinancialSnapshot({
      asOf: '2026-08-11',
      availableBalance: 3000,
      requiredBuffer: 500,
      transactions: [
        { id: 'pending-1', accountId: 'checking', amount: -100, date: '2026-08-11', pending: true, classification: 'spending' },
        { id: 'transfer-1', accountId: 'checking', amount: -1000, date: '2026-08-11', pending: true, classification: 'transfer' },
        { id: 'card-payment', accountId: 'checking', amount: -700, date: '2026-08-11', pending: true, classification: 'credit_card_payment' },
      ],
      bills: [
        { id: 'electric', amount: 200, dueDate: '2026-08-15', status: 'upcoming', confidence: 1 },
        { id: 'mortgage', amount: 1800, dueDate: '2026-08-20', status: 'upcoming', confidence: 1 },
      ],
      expectedIncome: [
        { id: 'paycheck', amount: 2500, expectedDate: '2026-08-14', confidence: 0.9 },
      ],
    });

    expect(result.pendingSpending).toBe(100);
    expect(result.upcomingBills).toBe(2000);
    expect(result.expectedIncome).toBe(2500);
    expect(result.safeToSpend).toBe(2900);
  });

  it('does not count transfers or card payments as spending', () => {
    const result = buildFinancialSnapshot({
      asOf: '2026-08-11',
      availableBalance: 1000,
      requiredBuffer: 0,
      transactions: [
        { id: 'transfer', accountId: 'checking', amount: -500, date: '2026-08-11', pending: true, classification: 'transfer' },
        { id: 'card', accountId: 'checking', amount: -500, date: '2026-08-11', pending: true, classification: 'credit_card_payment' },
      ],
      bills: [],
      expectedIncome: [],
    });

    expect(result.pendingSpending).toBe(0);
    expect(result.safeToSpend).toBe(1000);
  });

  it('excludes low-confidence expected income', () => {
    const result = buildFinancialSnapshot({
      asOf: '2026-08-11',
      availableBalance: 1000,
      requiredBuffer: 0,
      transactions: [],
      bills: [],
      expectedIncome: [{ id: 'guess', amount: 5000, expectedDate: '2026-08-12', confidence: 0.59 }],
    });

    expect(result.expectedIncome).toBe(0);
    expect(result.safeToSpend).toBe(1000);
  });
});
