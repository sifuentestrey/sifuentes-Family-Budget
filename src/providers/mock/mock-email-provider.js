/**
 * Mock email provider — NOT A REAL INTEGRATION.
 *
 * `info.isLive` is false and every consumer is expected to check it. Nothing
 * here contacts a mail server; it replays fixture messages so the ingestion
 * pipeline can be exercised and tested without credentials.
 *
 * The fixtures deliberately include the messages that break naive parsers:
 * a payment confirmation that reads like a bill, an ambiguous numeric date, a
 * statement listing several dollar amounts of which only one is owed, a
 * duplicate arriving through a second channel, and a promotional email using
 * billing vocabulary.
 *
 * To add Gmail: implement the same four methods against the Gmail API and
 * register it instead. No other file changes.
 */

/** @type {import('../types.js').EmailMessage[]} */
export const MOCK_MESSAGES = [
  {
    id: 'msg_utility_001',
    from: 'billing@examplepower.com',
    fromName: 'Example Power & Light',
    subject: 'Your July statement is ready',
    receivedAt: '2026-07-18T14:02:00Z',
    bodyText: [
      'Your Example Power & Light statement is available.',
      '',
      'Account Number: ****8842',
      'Statement Date: July 17, 2026',
      'Service Period: June 16, 2026 to July 15, 2026',
      '',
      'Previous Balance          $186.44',
      'Payment Received         -$186.44',
      'Current Charges           $203.17',
      'Total Amount Due          $203.17',
      'Payment Due Date: August 8, 2026',
      '',
      'Thank you for being a customer.',
    ].join('\n'),
  },
  {
    // Same bill as a PDF-style notice. Must be caught as a duplicate.
    id: 'msg_utility_001_dup',
    from: 'no-reply@examplepower.com',
    fromName: 'Example Power & Light',
    subject: 'Reminder: payment due soon',
    receivedAt: '2026-08-01T09:00:00Z',
    bodyText: [
      'This is a reminder that your bill is due.',
      'Account ending 8842',
      'Amount Due: $203.17',
      'Due Date: 08/08/2026',
    ].join('\n'),
  },
  {
    // HTML, table-based, with an ambiguous numeric date.
    id: 'msg_water_002',
    from: 'ebill@examplewater.org',
    fromName: 'Example Water District',
    subject: 'Water bill — account 3391',
    receivedAt: '2026-07-22T11:30:00Z',
    bodyHtml: `
      <html><body>
        <table>
          <tr><td>Account Number</td><td>****3391</td></tr>
          <tr><td>Statement Date</td><td>07/20/2026</td></tr>
          <tr><td>Current Charges</td><td>$74.20</td></tr>
          <tr><td>Balance Due</td><td>$74.20</td></tr>
          <tr><td>Due Date</td><td>08/05/2026</td></tr>
        </table>
        <p>Please pay by the due date to avoid a late fee.</p>
      </body></html>`,
  },
  {
    // Payment confirmation. Parses beautifully into a bill that is not owed.
    id: 'msg_confirmation_003',
    from: 'no-reply@examplepower.com',
    fromName: 'Example Power & Light',
    subject: 'Payment received — thank you',
    receivedAt: '2026-07-05T16:45:00Z',
    bodyText: [
      'Thank you for your payment.',
      'Payment Received: $186.44',
      'Payment Date: July 5, 2026',
      'Account ending 8842',
    ].join('\n'),
  },
  {
    // Marketing using billing words.
    id: 'msg_promo_004',
    from: 'offers@exampleinternet.com',
    fromName: 'Example Internet',
    subject: 'Save 20% on your monthly bill!',
    receivedAt: '2026-07-11T08:00:00Z',
    bodyText: [
      'Limited time offer — save 20% on your internet bill for 12 months.',
      'Refer a friend and get an account credit.',
      'Unsubscribe here.',
    ].join('\n'),
  },
  {
    id: 'msg_internet_005',
    from: 'billing@exampleinternet.com',
    fromName: 'Example Internet',
    subject: 'Your invoice is ready',
    receivedAt: '2026-07-25T07:15:00Z',
    bodyText: [
      'Invoice for account ending 5520',
      'Billing Date: 2026-07-24',
      'Monthly service                $89.99',
      'Equipment rental               $10.00',
      'Total Amount Due               $99.99',
      'Due Date: 2026-08-14',
    ].join('\n'),
  },
  {
    // Insurance premium, month-name date, no year — tests year inference.
    id: 'msg_insurance_006',
    from: 'documents@exampleinsurance.com',
    fromName: 'Example Mutual Insurance',
    subject: 'Auto policy renewal notice',
    receivedAt: '2026-07-28T13:20:00Z',
    bodyText: [
      'Your auto insurance premium is due.',
      'Policy ending 7761',
      'Statement Date: July 27, 2026',
      'Total Due: $1,428.00',
      'Payment Due: September 1',
    ].join('\n'),
  },
];

/**
 * @param {object} [options]
 * @param {import('../types.js').EmailMessage[]} [options.messages]
 * @param {boolean} [options.connected=true]
 * @returns {import('../types.js').EmailProvider}
 */
export function createMockEmailProvider(options = {}) {
  const messages = options.messages ?? MOCK_MESSAGES;
  const connected = options.connected ?? true;

  return {
    info: {
      key: 'mock-email',
      displayName: 'Mock Email (fixtures)',
      kind: 'email',
      // The whole point. Consumers render this as "not connected".
      isLive: false,
      authType: 'none',
    },

    async isConnected() {
      return connected;
    },

    async searchMessages(query = {}) {
      let results = [...messages];

      if (query.since) {
        results = results.filter((m) => m.receivedAt.slice(0, 10) >= query.since);
      }
      if (query.fromDomains?.length) {
        results = results.filter((m) =>
          query.fromDomains.some((domain) => m.from.toLowerCase().includes(domain.toLowerCase())));
      }
      if (query.keywords?.length) {
        results = results.filter((m) => {
          const haystack = `${m.subject} ${m.bodyText ?? ''} ${m.bodyHtml ?? ''}`.toLowerCase();
          return query.keywords.some((k) => haystack.includes(k.toLowerCase()));
        });
      }
      if (query.limit) results = results.slice(0, query.limit);

      return results;
    },

    async getMessage(id) {
      return messages.find((m) => m.id === id) ?? null;
    },
  };
}
