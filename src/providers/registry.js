/**
 * Provider registry.
 *
 * Central place adapters are registered and looked up, so the sync engine and
 * the UI never import a specific provider. Adding Gmail or ADP means registering
 * one more adapter; nothing downstream changes.
 *
 * Contracts are validated at registration rather than at call time. A provider
 * missing a method should fail immediately and visibly, not halfway through a
 * nightly sync where the symptom is silently missing bills.
 */

import { validateProvider } from './types.js';

/**
 * @typedef {object} ConnectionStatus
 * @property {string} key
 * @property {string} displayName
 * @property {string} kind
 * @property {boolean} isLive
 * @property {boolean} connected
 * @property {string} [lastSyncedAt]
 * @property {string} [error]
 */

export function createRegistry() {
  /** @type {Map<string, object>} */
  const providers = new Map();

  return {
    /**
     * @param {object} adapter
     * @throws when the adapter does not satisfy its contract
     */
    register(adapter) {
      const { valid, errors } = validateProvider(adapter);
      if (!valid) {
        throw new Error(
          `Cannot register provider "${adapter?.info?.key ?? 'unknown'}": ${errors.join('; ')}`,
        );
      }
      if (providers.has(adapter.info.key)) {
        throw new Error(`Provider "${adapter.info.key}" is already registered`);
      }
      providers.set(adapter.info.key, adapter);
      return adapter;
    },

    unregister(key) {
      return providers.delete(key);
    },

    get(key) {
      return providers.get(key) ?? null;
    },

    /** @param {string} [kind] */
    list(kind) {
      const all = [...providers.values()];
      return kind ? all.filter((p) => p.info.kind === kind) : all;
    },

    /**
     * Only providers that are BOTH live and connected.
     *
     * The distinction is deliberate and load-bearing: a mock reports connected
     * so tests can run it, but it must never count as a real connection. This
     * is the method the UI uses to decide whether it can honestly say the
     * household's accounts are connected.
     */
    async liveConnected(kind) {
      const candidates = this.list(kind).filter((p) => p.info.isLive);
      const results = await Promise.all(candidates.map(async (p) => {
        try {
          return (await p.isConnected()) ? p : null;
        } catch {
          return null;
        }
      }));
      return results.filter(Boolean);
    },

    /**
     * Status of every registered provider, for the sync/settings screen.
     * @param {Record<string, {lastSyncedAt?: string}>} [syncState]
     * @returns {Promise<ConnectionStatus[]>}
     */
    async status(syncState = {}) {
      return Promise.all(this.list().map(async (provider) => {
        const base = {
          key: provider.info.key,
          displayName: provider.info.displayName,
          kind: provider.info.kind,
          isLive: provider.info.isLive,
          lastSyncedAt: syncState[provider.info.key]?.lastSyncedAt,
        };
        try {
          return { ...base, connected: await provider.isConnected() };
        } catch (error) {
          return { ...base, connected: false, error: error.message };
        }
      }));
    },

    /**
     * Whether any REAL integration exists for a kind.
     *
     * Used to keep the UI honest: with no live provider, the interface should
     * offer to connect one rather than implying data is flowing.
     */
    hasLiveProvider(kind) {
      return this.list(kind).some((p) => p.info.isLive);
    },

    clear() {
      providers.clear();
    },

    get size() {
      return providers.size;
    },
  };
}

/** Shared default registry. Tests should build their own with createRegistry(). */
export const registry = createRegistry();
