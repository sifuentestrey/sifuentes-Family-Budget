/**
 * Known household connector targets.
 *
 * These are capability declarations, not claims that an account is connected.
 * A row becomes live only after an approved server-side adapter succeeds.
 */
export const PROVIDER_REGISTRY = Object.freeze([
  {
    key: 'ukg',
    displayName: 'UKG / timecard export',
    kind: 'payroll',
    liveAdapter: false,
    fallback: 'timecard_import',
    note: 'Use an employer-approved API or export; never scrape credentials.',
  },
  {
    key: 'tvec',
    displayName: 'TVEC electric',
    kind: 'bills',
    liveAdapter: false,
    fallback: 'email_import',
    note: 'Provider bill emails/PDFs or an approved portal adapter feed the same history.',
  },
  {
    key: 'watermark',
    displayName: 'Watermark water',
    kind: 'bills',
    liveAdapter: false,
    fallback: 'email_import',
    note: 'Provider bill emails/PDFs or an approved portal adapter feed the same history.',
  },
]);
