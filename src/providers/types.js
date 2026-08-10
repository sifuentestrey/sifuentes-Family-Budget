/**
 * Provider adapter contracts.
 *
 * Every external system enters the application through one of these. The point
 * is that adding Gmail, or ADP, or a specific utility's API later touches only
 * a new file in `src/providers/` — never the parsers, the budget, or the UI.
 *
 * These are contracts expressed as JSDoc typedefs plus a runtime shape check,
 * not classes to extend. Adapters are plain objects, which keeps them trivial
 * to write and to fake in tests.
 *
 * ## Honesty rule
 *
 * Every adapter must declare `isLive`. A mock adapter returns `false`, and the
 * UI is expected to render it as "not connected" rather than showing invented
 * data as though a real service produced it. Nothing in this codebase should
 * ever imply a connection that does not exist.
 */

/** @typedef {'email'|'bills'|'payroll'|'documents'} ProviderKind */

/**
 * @typedef {object} ProviderInfo
 * @property {string} key            - stable slug, e.g. "gmail", "mock-email"
 * @property {string} displayName
 * @property {ProviderKind} kind
 * @property {boolean} isLive        - false for mocks. Never lie about this.
 * @property {string} [authType]     - "oauth2" | "api_key" | "none"
 * @property {string[]} [scopes]
 */

/**
 * @typedef {object} SyncCapabilities
 * @property {boolean} incremental   - supports a cursor/since token
 * @property {number} [minIntervalMinutes] - rate-limit hint for the scheduler
 */

/**
 * An email account we can search for bill messages.
 *
 * Intentionally narrow: search and fetch, nothing else. A bill ingester never
 * needs to send mail or modify a mailbox, and an adapter that cannot do those
 * things cannot be abused into doing them.
 *
 * @typedef {object} EmailProvider
 * @property {ProviderInfo} info
 * @property {() => Promise<boolean>} isConnected
 * @property {(query: EmailQuery) => Promise<EmailMessage[]>} searchMessages
 * @property {(id: string) => Promise<EmailMessage|null>} getMessage
 * @property {(messageId: string, attachmentId: string) => Promise<Uint8Array|null>} [getAttachment]
 */

/**
 * @typedef {object} EmailQuery
 * @property {string} [since]        - ISO date; only messages after this
 * @property {string[]} [fromDomains]
 * @property {string[]} [keywords]
 * @property {number} [limit]
 * @property {string} [cursor]
 */

/**
 * @typedef {object} EmailAttachment
 * @property {string} id
 * @property {string} filename
 * @property {string} mimeType
 * @property {number} [sizeBytes]
 */

/**
 * @typedef {object} EmailMessage
 * @property {string} id
 * @property {string} from
 * @property {string} [fromName]
 * @property {string} subject
 * @property {string} receivedAt     - ISO timestamp
 * @property {string} [bodyText]
 * @property {string} [bodyHtml]
 * @property {EmailAttachment[]} [attachments]
 */

/**
 * A provider that can hand us bills directly — a utility with an API, or an
 * aggregator. Preferred over email parsing whenever it exists, because the
 * amounts are authoritative rather than inferred.
 *
 * @typedef {object} BillProvider
 * @property {ProviderInfo} info
 * @property {SyncCapabilities} capabilities
 * @property {() => Promise<boolean>} isConnected
 * @property {(options?: {since?: string, cursor?: string}) => Promise<{bills: import('../domain/bill.js').Bill[], cursor?: string}>} getBills
 */

/**
 * Timekeeping / payroll system.
 *
 * @typedef {object} PayrollProvider
 * @property {ProviderInfo} info
 * @property {SyncCapabilities} capabilities
 * @property {() => Promise<boolean>} isConnected
 * @property {(period: {start: string, end: string}) => Promise<import('../domain/payroll.js').TimeEntry[]>} getTimecard
 * @property {(options?: {since?: string}) => Promise<import('../domain/payroll.js').Paystub[]>} getPaystubs
 * @property {() => Promise<import('../domain/payroll.js').PayProfile|null>} [getPayProfile]
 */

/**
 * Turns a document (PDF bytes, HTML, plain text) into structured fields.
 * Separate from the provider so the same parser works on a PDF whether it
 * arrived by email, download, or upload.
 *
 * @typedef {object} DocumentParser
 * @property {string} key
 * @property {(input: ParseInput) => boolean} canParse
 * @property {(input: ParseInput) => Promise<ParsedDocument>} parse
 */

/**
 * @typedef {object} ParseInput
 * @property {'text'|'html'|'pdf'} kind
 * @property {string} [text]
 * @property {Uint8Array} [bytes]
 * @property {string} [filename]
 * @property {string} [fromAddress]
 * @property {string} [subject]
 */

/**
 * @typedef {object} ParsedDocument
 * @property {Record<string, unknown>} fields
 * @property {number} confidence
 * @property {string[]} [warnings]
 */

/**
 * @typedef {object} PaystubParser
 * @property {string} key
 * @property {(input: ParseInput) => boolean} canParse
 * @property {(input: ParseInput) => Promise<import('../domain/payroll.js').Paystub|null>} parse
 */

const REQUIRED_BY_KIND = {
  email: ['isConnected', 'searchMessages', 'getMessage'],
  bills: ['isConnected', 'getBills'],
  payroll: ['isConnected', 'getTimecard', 'getPaystubs'],
  documents: ['canParse', 'parse'],
};

/**
 * Runtime check that an adapter satisfies its contract.
 *
 * Worth having because adapters are plain objects with no compiler enforcing
 * the shape. A provider missing a method should fail loudly at registration,
 * not halfway through a nightly sync where the error surfaces as missing bills.
 *
 * @param {object} adapter
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateProvider(adapter) {
  const errors = [];

  if (!adapter?.info) {
    return { valid: false, errors: ['adapter.info is required'] };
  }
  const { key, displayName, kind, isLive } = adapter.info;

  if (!key) errors.push('info.key is required');
  if (!displayName) errors.push('info.displayName is required');
  if (!REQUIRED_BY_KIND[kind]) errors.push(`unknown info.kind: ${kind}`);
  // Not defaulted: an adapter that forgets to declare liveness must fail rather
  // than be assumed live, because the UI uses this to decide whether to tell
  // the user their accounts are connected.
  if (typeof isLive !== 'boolean') errors.push('info.isLive must be an explicit boolean');

  for (const method of REQUIRED_BY_KIND[kind] ?? []) {
    if (typeof adapter[method] !== 'function') {
      errors.push(`${kind} provider must implement ${method}()`);
    }
  }

  return { valid: errors.length === 0, errors };
}
