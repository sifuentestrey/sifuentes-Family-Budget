// GENERATED FILE — do not edit.
// Source of truth: src/sync/sync-engine.js
// Regenerate with: npm run sync:shared
/**
 * Sync engine.
 *
 * Runs provider syncs and records what happened. Every run produces a SyncRun
 * whether it succeeded or not, because the failure case is the one that matters:
 * a dashboard showing last week's numbers looks exactly like a working one, and
 * without a visible record of the last successful sync nobody notices for weeks.
 *
 * Storage is injected rather than assumed, so the engine runs identically
 * against Postgres, an in-memory store in tests, or nothing at all.
 */

import { providersMatch } from '../domain/provider-match.js';

const round = (n) => Math.round(n * 100) / 100;

/**
 * @typedef {object} SyncRun
 * @property {string} id
 * @property {string} householdId
 * @property {string} provider
 * @property {'bills'|'payroll'|'paystubs'} kind
 * @property {string} startedAt
 * @property {string} [completedAt]
 * @property {'running'|'success'|'partial'|'error'|'skipped'} status
 * @property {number} itemsFound
 * @property {number} itemsCreated
 * @property {number} itemsUpdated
 * @property {number} itemsSkipped
 * @property {number} duplicatesDetected
 * @property {{stage: string, message: string}[]} errors
 * @property {boolean} providerIsLive
 * @property {number} [durationMs]
 */

/**
 * @typedef {object} SyncStore
 * @property {(run: SyncRun) => Promise<SyncRun>} recordRun
 * @property {(run: SyncRun) => Promise<SyncRun>} completeRun
 * @property {(householdId: string) => Promise<object[]>} getExistingBills
 * @property {(bills: object[]) => Promise<number>} saveBills
 * @property {(bills: {existing: object, candidate: object}[]) => Promise<number>} [updateBills]
 * @property {(householdId: string) => Promise<object[]>} getExistingPaystubs
 * @property {(stubs: object[]) => Promise<number>} savePaystubs
 * @property {(entries: object[]) => Promise<{created: number, updated: number}>} saveTimeEntries
 * @property {(householdId: string) => Promise<Record<string, {lastSyncedAt: string}>>} [getSyncState]
 */

function newRun(householdId, provider, kind, isLive) {
  return {
    id: randomId('sync'),
    householdId,
    provider,
    kind,
    startedAt: new Date().toISOString(),
    status: 'running',
    itemsFound: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    itemsSkipped: 0,
    duplicatesDetected: 0,
    errors: [],
    providerIsLive: isLive,
  };
}

function finish(run, status) {
  run.completedAt = new Date().toISOString();
  run.status = status;
  run.durationMs = Date.parse(run.completedAt) - Date.parse(run.startedAt);
  return run;
}

/**
 * A Delete/stop-tracking choice is household truth, not a weak parser hint.
 * The ignored marker intentionally survives across monthly cycles, so a new
 * Gmail statement from the same provider cannot resurrect an ended payoff or
 * cancelled subscription. Only the explicit user add flow clears this flag.
 */
export function isUserSuppressedBill(candidate, existingBills = []) {
  const candidateProvider = candidate?.providerName || candidate?.providerKey || '';
  if (!candidateProvider) return false;
  return existingBills.some((existing) =>
    existing.status === 'ignored'
      && existing.raw?.planning?.suppressedRecurring === true
      && providersMatch(existing.providerName || existing.providerKey || '', candidateProvider),
  );
}

/**
 * Sync bills from a bill provider or an email provider.
 *
 * @param {object} options
 * @param {object} options.provider
 * @param {SyncStore} options.store
 * @param {string} options.householdId
 * @param {string} [options.since]
 * @param {(provider: object, opts: object) => Promise<object>} [options.emailIngester]
 * @returns {Promise<SyncRun>}
 */
export async function syncBills(options) {
  const { provider, store, householdId } = options;
  const run = newRun(householdId, provider.info.key, 'bills', provider.info.isLive);
  await store.recordRun?.(run);

  try {
    const connected = await provider.isConnected();
    if (!connected) {
      run.errors.push({ stage: 'connect', message: `${provider.info.displayName} is not connected` });
      return finish(run, 'skipped');
    }

    const existing = await store.getExistingBills(householdId);
    let accepted = [];
    let duplicates = [];
    let needsReview = [];

    if (provider.info.kind === 'email') {
      const ingest = await options.emailIngester(provider, {
        householdId,
        since: options.since,
        existingBills: existing,
      });

      run.itemsFound = ingest.billsParsed;
      run.itemsSkipped = ingest.skipped.length;
      accepted = ingest.billsAccepted;
      duplicates = ingest.duplicates;
      needsReview = ingest.needsReview;
      run.errors.push(...ingest.errors.map((e) => ({ stage: e.stage, message: e.message })));
    } else {
      const { bills } = await provider.getBills({ since: options.since });
      run.itemsFound = bills.length;

      const { partitionBills } = await import('../ingestion/dedupe.js');
      const partition = partitionBills(bills, existing);
      accepted = partition.accepted;
      duplicates = partition.duplicates;
    }

    const beforeSuppression = accepted.length + needsReview.length;
    accepted = accepted.filter((bill) => !isUserSuppressedBill(bill, existing));
    needsReview = needsReview.filter((bill) => !isUserSuppressedBill(bill, existing));
    run.itemsSkipped += beforeSuppression - accepted.length - needsReview.length;

    run.duplicatesDetected = duplicates.length;

    const updates = [];
    if (duplicates.length && store.updateBills) {
      const { shouldUpdateExisting } = await import('../ingestion/dedupe.js');
      for (const dup of duplicates) {
        if (isUserSuppressedBill(dup.candidate, existing)) {
          run.itemsSkipped++;
          continue;
        }
        const verdict = shouldUpdateExisting(dup.existing, dup.candidate);
        if (verdict.update) updates.push({ existing: dup.existing, candidate: dup.candidate });
      }
    }

    const toSave = [
      ...accepted,
      ...needsReview.map((b) => ({ ...b, status: 'detected', needsReview: true })),
    ];

    run.itemsCreated = toSave.length ? await store.saveBills(toSave) : 0;
    run.itemsUpdated = updates.length && store.updateBills ? await store.updateBills(updates) : 0;

    return finish(run, run.errors.length ? 'partial' : 'success');
  } catch (error) {
    run.errors.push({ stage: 'sync', message: error.message });
    return finish(run, 'error');
  } finally {
    await store.completeRun?.(run);
  }
}

export async function syncPayroll(options) {
  const { provider, store, householdId, period } = options;
  const run = newRun(householdId, provider.info.key, 'payroll', provider.info.isLive);
  await store.recordRun?.(run);

  try {
    if (!(await provider.isConnected())) {
      run.errors.push({ stage: 'connect', message: `${provider.info.displayName} is not connected` });
      return finish(run, 'skipped');
    }

    const entries = await provider.getTimecard(period);
    run.itemsFound = entries.length;
    const { created, updated } = await store.saveTimeEntries(entries);
    run.itemsCreated = created;
    run.itemsUpdated = updated;
    return finish(run, 'success');
  } catch (error) {
    run.errors.push({ stage: 'sync', message: error.message });
    return finish(run, 'error');
  } finally {
    await store.completeRun?.(run);
  }
}

export async function syncPaystubs(options) {
  const { provider, store, householdId } = options;
  const run = newRun(householdId, provider.info.key, 'paystubs', provider.info.isLive);
  await store.recordRun?.(run);

  try {
    if (!(await provider.isConnected())) {
      run.errors.push({ stage: 'connect', message: `${provider.info.displayName} is not connected` });
      return finish(run, 'skipped');
    }

    const stubs = await provider.getPaystubs({ since: options.since });
    run.itemsFound = stubs.length;

    const existing = await store.getExistingPaystubs(householdId);
    const { findDuplicatePaystub } = await import('../ingestion/dedupe.js');

    const fresh = [];
    for (const stub of stubs) {
      const verdict = findDuplicatePaystub(stub, [...existing, ...fresh]);
      if (verdict.isDuplicate) run.duplicatesDetected++;
      else fresh.push(stub);
    }

    run.itemsCreated = fresh.length ? await store.savePaystubs(fresh) : 0;
    return finish(run, 'success');
  } catch (error) {
    run.errors.push({ stage: 'sync', message: error.message });
    return finish(run, 'error');
  } finally {
    await store.completeRun?.(run);
  }
}

export function summarizeSyncState(runs, staleAfterHours = 26) {
  const latestByProvider = new Map();

  for (const run of runs ?? []) {
    const existing = latestByProvider.get(run.provider);
    if (!existing || run.startedAt > existing.startedAt) latestByProvider.set(run.provider, run);
  }

  const now = Date.now();
  const entries = [...latestByProvider.values()].map((run) => {
    const reference = run.completedAt ?? run.startedAt;
    const ageMinutes = Math.round((now - Date.parse(reference)) / 60000);
    const stale = ageMinutes > staleAfterHours * 60;

    return {
      provider: run.provider,
      kind: run.kind,
      status: run.status,
      isLive: run.providerIsLive,
      lastRunAt: reference,
      ageMinutes,
      relative: formatRelative(ageMinutes),
      stale,
      itemsCreated: run.itemsCreated,
      errors: run.errors,
    };
  });

  return {
    providers: entries.sort((a, b) => a.provider.localeCompare(b.provider)),
    anyStale: entries.some((e) => e.stale),
    anyErrors: entries.some((e) => e.status === 'error' || e.status === 'partial'),
    liveProviders: entries.filter((e) => e.isLive).length,
    mockProviders: entries.filter((e) => !e.isLive).length,
  };
}

function formatRelative(minutes) {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function createMemoryStore() {
  const bills = [];
  const paystubs = [];
  const timeEntries = [];
  const runs = [];

  return {
    bills, paystubs, timeEntries, runs,
    async recordRun(run) { runs.push(run); return run; },
    async completeRun(run) { return run; },
    async getExistingBills(householdId) { return bills.filter((b) => b.householdId === householdId); },
    async saveBills(newBills) { bills.push(...newBills); return newBills.length; },
    async updateBills(updates) {
      for (const { existing, candidate } of updates) {
        const index = bills.findIndex((b) => b.id === existing.id);
        if (index >= 0) bills[index] = { ...existing, ...candidate, id: existing.id };
      }
      return updates.length;
    },
    async getExistingPaystubs(householdId) { return paystubs.filter((s) => s.householdId === householdId); },
    async savePaystubs(stubs) { paystubs.push(...stubs); return stubs.length; },
    async saveTimeEntries(entries) {
      let created = 0;
      let updated = 0;
      for (const entry of entries) {
        const key = `${entry.payProfileId ?? 'default'}|${entry.date}`;
        const index = timeEntries.findIndex((e) => `${e.payProfileId ?? 'default'}|${e.date}` === key);
        if (index >= 0) { timeEntries[index] = entry; updated++; }
        else { timeEntries.push(entry); created++; }
      }
      return { created, updated };
    },
  };
}

function randomId(prefix) {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export { round };
