/**
 * Server-side connector contract.
 *
 * Connectors are adapters, not business logic. They return domain-shaped
 * records and never expose provider credentials to the browser.
 */

/** @typedef {object} ConnectorResult
 * @property {string} provider
 * @property {string} fetchedAt
 * @property {Array<object>} records
 * @property {'provider_api'|'email_import'|'pdf_import'|'transaction_match'} source
 * @property {string[]} warnings
 */

/** @typedef {object} TimecardConnector
 * @property {string} kind
 * @property {(context: object) => Promise<ConnectorResult>} fetchTimeEntries
 */

/** @typedef {object} UtilityConnector
 * @property {string} provider
 * @property {(context: object) => Promise<ConnectorResult>} fetchBills
 */

/** @returns {boolean} */
export function isConnectorResult(value) {
  return Boolean(value && typeof value.provider === 'string'
    && typeof value.fetchedAt === 'string' && Array.isArray(value.records)
    && Array.isArray(value.warnings));
}

export const CONNECTOR_SECURITY_RULES = Object.freeze([
  'Never accept UKG, TVEC, or Watermark passwords in the browser.',
  'Never put access tokens in localStorage, fixtures, or Git history.',
  'Persist provider sourceRef values and upsert by sourceRef to prevent duplicates.',
  'Show the source and last synced timestamp beside every imported record.',
]);
