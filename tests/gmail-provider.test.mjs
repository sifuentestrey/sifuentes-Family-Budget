/**
 * Gmail EmailProvider adapter — real integration, tested against a mocked
 * fetch so it never needs a live Google account.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGmailProvider, decodeBase64Url, decodeBase64UrlToBytes, findHeader, parseFromHeader,
  extractBody, buildGmailQuery,
} from '../src/providers/gmail-email-provider.js';

function b64urlBytes(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64url(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// decodeBase64Url
// ---------------------------------------------------------------------------

test('decodeBase64Url round-trips plain ASCII', () => {
  assert.equal(decodeBase64Url(b64url('Total Amount Due $203.17')), 'Total Amount Due $203.17');
});

test('decodeBase64Url handles multi-byte UTF-8, not just latin1', () => {
  // A curly apostrophe and an accented name — atob() alone would mangle these.
  assert.equal(decodeBase64Url(b64url("José’s statement")), "José’s statement");
});

test('decodeBase64Url tolerates missing padding at every remainder length', () => {
  for (const text of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
    assert.equal(decodeBase64Url(b64url(text)), text);
  }
});

test('decodeBase64Url returns empty string for falsy input', () => {
  assert.equal(decodeBase64Url(undefined), '');
  assert.equal(decodeBase64Url(''), '');
});

// ---------------------------------------------------------------------------
// decodeBase64UrlToBytes — the raw path, used for attachments (a PDF is not
// UTF-8 and must never go through TextDecoder, which is exactly what would
// corrupt it if the two decoders shared a code path all the way through).
// ---------------------------------------------------------------------------

test('decodeBase64UrlToBytes round-trips arbitrary binary, including bytes that are not valid UTF-8', () => {
  // 0xFF and 0xFE are invalid UTF-8 lead bytes on their own — a decoder that
  // routed through TextDecoder would replace them with U+FFFD and the
  // original bytes would never come back.
  const original = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00, 0x01, 0x7f]);
  const decoded = decodeBase64UrlToBytes(b64urlBytes(original));
  assert.deepEqual([...decoded], [...original]);
});

test('decodeBase64UrlToBytes returns an empty array for falsy input', () => {
  assert.equal(decodeBase64UrlToBytes(undefined).length, 0);
  assert.equal(decodeBase64UrlToBytes('').length, 0);
});

// ---------------------------------------------------------------------------
// findHeader / parseFromHeader
// ---------------------------------------------------------------------------

test('findHeader is case-insensitive and returns empty string when absent', () => {
  const headers = [{ name: 'Subject', value: 'Your bill' }];
  assert.equal(findHeader(headers, 'subject'), 'Your bill');
  assert.equal(findHeader(headers, 'From'), '');
});

test('parseFromHeader splits a quoted display name from the address', () => {
  const result = parseFromHeader('"Example Power & Light" <billing@examplepower.com>');
  assert.equal(result.from, 'billing@examplepower.com');
  assert.equal(result.fromName, 'Example Power & Light');
});

test('parseFromHeader handles a bare address with no display name', () => {
  const result = parseFromHeader('billing@examplepower.com');
  assert.equal(result.from, 'billing@examplepower.com');
  assert.equal(result.fromName, undefined);
});

// ---------------------------------------------------------------------------
// extractBody
// ---------------------------------------------------------------------------

test('extractBody reads a single-part plain-text message', () => {
  const payload = { mimeType: 'text/plain', body: { data: b64url('Amount Due $99.99') } };
  const result = extractBody(payload);
  assert.equal(result.text, 'Amount Due $99.99');
  assert.equal(result.html, '');
});

test('extractBody walks a multipart tree for both text and html parts', () => {
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', body: { data: b64url('plain version') } },
      { mimeType: 'text/html', body: { data: b64url('<p>html version</p>') } },
    ],
  };
  const result = extractBody(payload);
  assert.equal(result.text, 'plain version');
  assert.equal(result.html, '<p>html version</p>');
});

test('extractBody recurses into nested multipart/mixed with an attachment sibling', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('the bill text') } },
        ],
      },
      { mimeType: 'application/pdf', body: { attachmentId: 'att_1' } },
    ],
  };
  assert.equal(extractBody(payload).text, 'the bill text');
});

test('extractBody returns empty strings and no attachments for a payload with no data anywhere', () => {
  assert.deepEqual(extractBody({ mimeType: 'multipart/mixed', parts: [] }), { text: '', html: '', attachments: [] });
  assert.deepEqual(extractBody(null), { text: '', html: '', attachments: [] });
});

test('extractBody collects a PDF attachment alongside the plain-text part', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', body: { data: b64url('Your statement is attached.') } },
      { filename: 'statement.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att_1', size: 40213 } },
    ],
  };
  const result = extractBody(payload);
  assert.equal(result.text, 'Your statement is attached.');
  assert.equal(result.attachments.length, 1);
  assert.deepEqual(result.attachments[0], {
    id: 'att_1', filename: 'statement.pdf', mimeType: 'application/pdf', sizeBytes: 40213,
  });
});

test('extractBody finds an attachment nested under multipart/alternative inside multipart/mixed', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [{ mimeType: 'text/plain', body: { data: b64url('see attached') } }],
      },
      { filename: 'bill.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att_2', size: 1000 } },
    ],
  };
  assert.equal(extractBody(payload).attachments.length, 1);
  assert.equal(extractBody(payload).attachments[0].id, 'att_2');
});

// ---------------------------------------------------------------------------
// buildGmailQuery
// ---------------------------------------------------------------------------

test('buildGmailQuery translates since into Gmail\'s after: syntax', () => {
  assert.equal(buildGmailQuery({ since: '2026-07-01' }), 'after:2026/07/01');
});

test('buildGmailQuery ORs multiple from-domains inside one group', () => {
  assert.equal(
    buildGmailQuery({ fromDomains: ['examplepower.com', 'examplewater.org'] }),
    '(from:examplepower.com OR from:examplewater.org)',
  );
});

test('buildGmailQuery quotes multi-word keywords so Gmail treats them as phrases', () => {
  const q = buildGmailQuery({ keywords: ['bill', 'amount due'] });
  assert.equal(q, '(bill OR "amount due")');
});

test('buildGmailQuery combines all three clauses and returns empty string for an empty query', () => {
  const q = buildGmailQuery({ since: '2026-07-01', fromDomains: ['examplepower.com'], keywords: ['bill'] });
  assert.equal(q, 'after:2026/07/01 (from:examplepower.com) (bill)');
  assert.equal(buildGmailQuery({}), '');
});

// ---------------------------------------------------------------------------
// createGmailProvider — searchMessages / getMessage against a mocked fetch
// ---------------------------------------------------------------------------

function gmailMessage({ id, from, subject, internalDate, bodyText }) {
  return {
    id,
    internalDate: String(internalDate),
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
      ],
      mimeType: 'text/plain',
      body: { data: b64url(bodyText) },
    },
  };
}

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url.toString());
    const key = Object.keys(responses).find((pattern) => url.toString().includes(pattern));
    if (!key) throw new Error(`unexpected fetch: ${url}`);
    const body = responses[key];
    if (body instanceof Error) return { ok: false, status: 500, text: async () => body.message };
    return { ok: true, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

test('getMessage assembles an EmailMessage from headers, body, and internalDate', async () => {
  const fetchImpl = fakeFetch({
    '/messages/msg_1': gmailMessage({
      id: 'msg_1',
      from: '"Example Power & Light" <billing@examplepower.com>',
      subject: 'Your July statement',
      internalDate: Date.parse('2026-07-18T14:02:00Z'),
      bodyText: 'Total Amount Due $203.17',
    }),
  });
  const provider = createGmailProvider({ getAccessToken: async () => 'tok', fetchImpl });

  const message = await provider.getMessage('msg_1');
  assert.equal(message.id, 'msg_1');
  assert.equal(message.from, 'billing@examplepower.com');
  assert.equal(message.fromName, 'Example Power & Light');
  assert.equal(message.subject, 'Your July statement');
  assert.equal(message.receivedAt, '2026-07-18T14:02:00.000Z');
  assert.equal(message.bodyText, 'Total Amount Due $203.17');
});

test('searchMessages fetches the list then each message, and sends the access token', async () => {
  const fetchImpl = fakeFetch({
    '/messages?': { messages: [{ id: 'a' }, { id: 'b' }] },
    '/messages/a': gmailMessage({ id: 'a', from: 'x@y.com', subject: 'S1', internalDate: 1, bodyText: 't1' }),
    '/messages/b': gmailMessage({ id: 'b', from: 'x@y.com', subject: 'S2', internalDate: 2, bodyText: 't2' }),
  });
  const provider = createGmailProvider({ getAccessToken: async () => 'tok', fetchImpl });

  const results = await provider.searchMessages({ keywords: ['bill'], limit: 10 });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((m) => m.id), ['a', 'b']);
  assert.ok(fetchImpl.calls[0].includes('q=%28bill%29'), 'query string reaches the request');
});

test('searchMessages paginates across nextPageToken until the limit is reached', async () => {
  let page = 0;
  const fetchImpl = async (url) => {
    const s = url.toString();
    if (s.includes('/messages?')) {
      page++;
      return page === 1
        ? { ok: true, json: async () => ({ messages: [{ id: 'a' }], nextPageToken: 'p2' }) }
        : { ok: true, json: async () => ({ messages: [{ id: 'b' }] }) };
    }
    return { ok: true, json: async () => gmailMessage({ id: s.match(/messages\/(\w+)/)[1], from: 'x@y.com', subject: 'S', internalDate: 1, bodyText: 't' }) };
  };

  const provider = createGmailProvider({ getAccessToken: async () => 'tok', fetchImpl });
  const results = await provider.searchMessages({ limit: 10 });
  assert.equal(results.length, 2);
  assert.equal(page, 2, 'followed the nextPageToken to a second page');
});

test('a non-ok Gmail response raises with the status and body', async () => {
  const fetchImpl = fakeFetch({ '/messages/bad': new Error('quota exceeded') });
  const provider = createGmailProvider({ getAccessToken: async () => 'tok', fetchImpl });
  await assert.rejects(() => provider.getMessage('bad'), /Gmail API 500/);
});

test('isConnected reflects whether an access token can be obtained', async () => {
  const ok = createGmailProvider({ getAccessToken: async () => 'tok', fetchImpl: fakeFetch({}) });
  assert.equal(await ok.isConnected(), true);

  const broken = createGmailProvider({ getAccessToken: async () => { throw new Error('refresh failed'); }, fetchImpl: fakeFetch({}) });
  assert.equal(await broken.isConnected(), false);
});

test('info declares isLive: true and the read-only scope', () => {
  const provider = createGmailProvider({ getAccessToken: async () => 'tok' });
  assert.equal(provider.info.isLive, true);
  assert.equal(provider.info.key, 'gmail');
  assert.deepEqual(provider.info.scopes, ['https://www.googleapis.com/auth/gmail.readonly']);
});

test('getMessage reports a PDF attachment alongside a thin body', () => {
  const fetchImpl = fakeFetch({
    '/messages/msg_pdf': {
      id: 'msg_pdf',
      internalDate: '1',
      payload: {
        headers: [{ name: 'From', value: 'billing@examplepower.com' }, { name: 'Subject', value: 'Your statement' }],
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('Your e-bill is attached.') } },
          { filename: 'statement.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att_99', size: 12345 } },
        ],
      },
    },
  });
  const provider = createGmailProvider({ getAccessToken: async () => 'tok', fetchImpl });

  return provider.getMessage('msg_pdf').then((message) => {
    assert.equal(message.bodyText, 'Your e-bill is attached.');
    assert.equal(message.attachments.length, 1);
    assert.equal(message.attachments[0].filename, 'statement.pdf');
    assert.equal(message.attachments[0].mimeType, 'application/pdf');
  });
});

test('getAttachment fetches and decodes the raw bytes, not text', async () => {
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0xff]); // "%PDF-1" + a non-UTF8 byte
  const fetchImpl = fakeFetch({
    '/messages/msg_1/attachments/att_99': { size: pdfBytes.length, data: b64urlBytes(pdfBytes) },
  });
  const provider = createGmailProvider({ getAccessToken: async () => 'tok', fetchImpl });

  const bytes = await provider.getAttachment('msg_1', 'att_99');
  assert.deepEqual([...bytes], [...pdfBytes]);
});
