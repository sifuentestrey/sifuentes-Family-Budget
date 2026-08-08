import type { BillProvider } from './types';

/**
 * Provider registry. Add utility-specific sender/domain information here as we
 * connect real accounts. Never put usernames, passwords, API keys, or tokens
 * in this file or in the repository.
 */
export const BILL_PROVIDERS: BillProvider[] = [
  {
    id: 'electricity',
    name: 'Electricity',
    categories: ['electricity', 'utilities'],
  },
  {
    id: 'water',
    name: 'Water',
    categories: ['water', 'utilities'],
  },
  {
    id: 'internet',
    name: 'Internet',
    categories: ['internet', 'utilities'],
  },
  {
    id: 'natural-gas',
    name: 'Natural Gas',
    categories: ['gas', 'utilities'],
  },
];

export function findProviderByEmail(from: string): BillProvider | undefined {
  const normalized = from.toLowerCase();
  return BILL_PROVIDERS.find((provider) =>
    provider.senderAddresses?.some((address) => normalized.includes(address.toLowerCase())) ||
    provider.emailDomains?.some((domain) => normalized.includes(domain.toLowerCase())),
  );
}
