import { HOUSEHOLD_PROVIDERS } from '../providers/household-providers.js';

/**
 * Turns provider descriptors into a safe UI/readiness summary.
 * Never accepts or returns credentials.
 */
export function getConnectionReadiness({ configured = new Set(), connected = new Set() } = {}) {
  return HOUSEHOLD_PROVIDERS.map(provider => {
    const id = provider.id;
    const isConnected = connected.has(id);
    const isConfigured = configured.has(id);

    let status = 'needs_configuration';
    if (isConnected) status = 'connected';
    else if (isConfigured) status = 'ready_to_connect';

    return {
      id,
      name: provider.name,
      purpose: provider.purpose,
      kind: provider.kind,
      strategy: provider.strategy,
      priority: provider.priority,
      live: provider.live,
      status,
    };
  });
}

export function summarizeConnectionReadiness(options) {
  const items = getConnectionReadiness(options);
  return {
    total: items.length,
    connected: items.filter(item => item.status === 'connected').length,
    readyToConnect: items.filter(item => item.status === 'ready_to_connect').length,
    needsConfiguration: items.filter(item => item.status === 'needs_configuration').length,
    items,
  };
}
