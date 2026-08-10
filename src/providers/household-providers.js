/**
 * The household's intended integration map.
 *
 * These are descriptors, not credentials and not live connections. Keeping the
 * map separate from provider implementations lets the UI show what is ready,
 * what needs configuration, and what still needs provider research.
 */
export const HOUSEHOLD_PROVIDERS = Object.freeze([
  {
    id: 'bofa',
    name: 'Bank of America',
    purpose: 'checking',
    kind: 'bank',
    strategy: 'plaid',
    priority: 1,
    live: false,
  },
  {
    id: 'chase',
    name: 'Chase',
    purpose: "wife's checking",
    kind: 'bank',
    strategy: 'plaid',
    priority: 1,
    live: false,
  },
  {
    id: 'ukg-time',
    name: 'UKG',
    purpose: 'timecard',
    kind: 'payroll',
    strategy: 'official_api_or_email',
    priority: 1,
    live: false,
  },
  {
    id: 'ukg-payroll',
    name: 'UKG',
    purpose: 'paystub',
    kind: 'payroll',
    strategy: 'official_api_or_email',
    priority: 1,
    live: false,
  },
  {
    id: 'pennymac',
    name: 'Pennymac',
    purpose: 'mortgage',
    kind: 'loan',
    strategy: 'provider_or_email_or_bank_evidence',
    priority: 2,
    live: false,
  },
  {
    id: 'advancial',
    name: 'Advancial',
    purpose: 'auto loan',
    kind: 'loan',
    strategy: 'provider_or_email_or_bank_evidence',
    priority: 2,
    live: false,
  },
  {
    id: 'tvec',
    name: 'TVEC',
    purpose: 'electricity',
    kind: 'utility',
    strategy: 'verify_identity_then_api_or_email',
    priority: 2,
    live: false,
  },
  {
    id: 'watermark',
    name: 'Watermark',
    purpose: 'water',
    kind: 'utility',
    strategy: 'verify_identity_then_api_or_email',
    priority: 2,
    live: false,
  },
  {
    id: 'email',
    name: 'Household email',
    purpose: 'bill_and_paystub_discovery',
    kind: 'email',
    strategy: 'gmail_or_microsoft_graph',
    priority: 1,
    live: false,
  },
]);

export function getProvider(id) {
  return HOUSEHOLD_PROVIDERS.find(provider => provider.id === id);
}
