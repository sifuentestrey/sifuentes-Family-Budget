import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore, isUserSuppressedBill, syncBills } from '../src/sync/sync-engine.js';

test('user-suppressed provider matches future cycles by provider, not old due date', () => {
  const marker = {
    householdId: 'h1',
    providerName: 'Spotify',
    providerKey: 'spotify',
    amountDue: 14.06,
    dueDate: '2026-06-22',
    status: 'ignored',
    source: 'manual',
    raw: { planning: { suppressedRecurring: true } },
  };
  const future = {
    householdId: 'h1',
    providerName: 'Spotify USA',
    providerKey: 'spotify-usa',
    amountDue: 14.06,
    dueDate: '2026-09-22',
    status: 'confirmed',
    source: 'provider_api',
  };

  assert.equal(isUserSuppressedBill(future, [marker]), true);
});

test('bill provider cannot resurrect a deleted obligation on a later month', async () => {
  const store = createMemoryStore();
  store.bills.push({
    id: 'ignored_spotify',
    householdId: 'h1',
    providerName: 'Spotify',
    providerKey: 'spotify',
    amountDue: 14.06,
    dueDate: '2026-06-22',
    status: 'ignored',
    source: 'manual',
    raw: { planning: { suppressedRecurring: true } },
  });

  const provider = {
    info: { key: 'test-bills', displayName: 'Test Bills', kind: 'bills', isLive: true },
    async isConnected() { return true; },
    async getBills() {
      return {
        bills: [{
          id: 'candidate_spotify',
          householdId: 'h1',
          providerName: 'Spotify',
          providerKey: 'spotify',
          amountDue: 14.06,
          dueDate: '2026-09-22',
          status: 'confirmed',
          source: 'provider_api',
          confidence: 1,
        }],
      };
    },
  };

  const run = await syncBills({ provider, store, householdId: 'h1' });
  assert.equal(run.status, 'success');
  assert.equal(run.itemsCreated, 0);
  assert.equal(run.itemsSkipped, 1);
  assert.equal(store.bills.length, 1);
});
