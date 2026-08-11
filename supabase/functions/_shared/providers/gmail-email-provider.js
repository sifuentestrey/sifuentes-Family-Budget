// GENERATED FILE — do not edit.
// Source of truth: src/providers/gmail-email-provider.js
// Regenerate with: npm run sync:shared
/**
 * Gmail EmailProvider adapter — real integration.
 *
 * Read-only (`gmail.readonly` scope; see docs/ARCHITECTURE.md's security
 * model, which rules out anything that could send or modify mail). This file
 * never sees a refresh token or does OAuth itself — the caller injects
 * `getAccessToken`, a function that returns a short-lived access token. In
 * production that closure lives in the sync Edge Function, which exchanges
 * the Vault-held refresh token for an access token once per run and caches
 * it; in tests it is a plain stub.
 */

const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * The raw bytes behind a base64url payload. Gmail uses base64url (not
 * standard base64) for both text body parts and binary attachments alike —
 * this is the shared decode step; `decodeBase64Url` below adds UTF-8 text
 * decoding on top for the body-part case, and PDF attachments use these bytes
 * directly, since running a PDF through TextDecoder would corrupt it.
 */
export function decodeBase64UrlToBytes(data) {
  if (!data) return new Uint8Array(0);
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Gmail sends body parts as base64url, not standard base64, and the payload
 * is UTF-8 — `atob()` alone decodes to a binary string, which mangles any
 * multi-byte character (curly quotes in a statement's boilerplate, an accented
 * name), so the bytes are handed to `TextDecoder` rather than used directly.
 */
export function decodeBase64Url(data) {
  if (!data) return '';
  return new TextDecoder('utf-8').decode(decodeBase64UrlToBytes(data));
}

export function findHeader(headers, name) {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/** `"Example Power & Light" <billing@examplepower.com>` -> the two parts separately. */
export function parseFromHeader(raw) {
  const match = raw.match(/^(.*?)<([^>]+)>\s*$/);
  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, '');
    return { from: match[2].trim(), fromName: name || undefined };
  }
  return { from: raw.trim(), fromName: undefined };
}

/**
 * Gmail messages are a MIME tree, not a flat body — a bill with an HTML part,
 * a plain-text fallback, and a PDF statement attached all nest under
 * `payload.parts`. Walks it once and keeps the first plain-text part, the
 * first HTML part, and every attachment found (identified by a non-empty
 * `filename` paired with `body.attachmentId` — Gmail's convention for "this
 * part must be fetched separately," as opposed to `body.data`, which is
 * inline).
 */
export function extractBody(payload) {
  if (!payload) return { text: '', html: '', attachments: [] };

  if (payload.filename && payload.body?.attachmentId) {
    return {
      text: '', html: '',
      attachments: [{
        id: payload.body.attachmentId,
        filename: payload.filename,
        mimeType: payload.mimeType,
        sizeBytes: payload.body.size,
      }],
    };
  }
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return { text: decodeBase64Url(payload.body.data), html: '', attachments: [] };
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return { text: '', html: decodeBase64Url(payload.body.data), attachments: [] };
  }
  if (payload.parts?.length) {
    let text = '';
    let html = '';
    const attachments = [];
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested.text && !text) text = nested.text;
      if (nested.html && !html) html = nested.html;
      attachments.push(...nested.attachments);
    }
    return { text, html, attachments };
  }
  return { text: '', html: '', attachments: [] };
}

/**
 * Translate an `EmailQuery` into Gmail's own search syntax, so filtering
 * happens server-side at Gmail rather than downloading an entire mailbox and
 * discarding most of it locally — the architecture's explicit anti-goal.
 */
export function buildGmailQuery(query = {}) {
  const parts = [];
  if (query.since) parts.push(`after:${query.since.slice(0, 10).replace(/-/g, '/')}`);
  if (query.fromDomains?.length) {
    parts.push('(' + query.fromDomains.map((d) => `from:${d}`).join(' OR ') + ')');
  }
  if (query.keywords?.length) {
    parts.push('(' + query.keywords.map((k) => (k.includes(' ') ? `"${k}"` : k)).join(' OR ') + ')');
  }
  return parts.join(' ');
}

/**
 * @param {object} options
 * @param {() => Promise<string>} options.getAccessToken
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {import('./types.js').EmailProvider}
 */
export function createGmailProvider({ getAccessToken, fetchImpl = fetch }) {
  async function authedFetch(url) {
    const token = await getAccessToken();
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Gmail API ${response.status}: ${body.slice(0, 200)}`);
    }
    return response.json();
  }

  async function getMessage(id) {
    const message = await authedFetch(`${API_BASE}/messages/${id}?format=full`);
    const headers = message.payload?.headers;
    const { from, fromName } = parseFromHeader(findHeader(headers, 'From'));
    const { text, html, attachments } = extractBody(message.payload);

    return {
      id: message.id,
      from,
      fromName,
      subject: findHeader(headers, 'Subject'),
      receivedAt: new Date(Number(message.internalDate)).toISOString(),
      bodyText: text || undefined,
      bodyHtml: html || undefined,
      attachments: attachments.length ? attachments : undefined,
    };
  }

  /** Raw bytes of one attachment — a second API call, since Gmail never inlines them into getMessage(). */
  async function getAttachment(messageId, attachmentId) {
    const result = await authedFetch(`${API_BASE}/messages/${messageId}/attachments/${attachmentId}`);
    return decodeBase64UrlToBytes(result.data);
  }

  /**
   * How many messages to fetch at once within a page.
   *
   * getMessage is one Gmail API round trip per message with no batch
   * endpoint in play here, so fetching a page's worth one at a time is pure
   * added wall-clock for no benefit — a 90-day initial sync against a real
   * inbox can turn up close to the full 200-message limit, and 200
   * sequential round trips is exactly what exceeded the edge function's
   * resource limit on this household's very first real sync. Bounded
   * concurrency keeps the improvement without opening enough simultaneous
   * connections to trip Gmail's own per-user rate limit.
   */
  const MESSAGE_FETCH_CONCURRENCY = 10;

  async function searchMessages(query = {}) {
    const q = buildGmailQuery(query);
    const limit = query.limit ?? 200;
    const results = [];
    let pageToken = query.cursor;

    do {
      const url = new URL(`${API_BASE}/messages`);
      if (q) url.searchParams.set('q', q);
      url.searchParams.set('maxResults', String(Math.min(100, limit - results.length)));
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const page = await authedFetch(url.toString());
      const ids = (page.messages ?? []).slice(0, limit - results.length).map((m) => m.id);
      for (let i = 0; i < ids.length; i += MESSAGE_FETCH_CONCURRENCY) {
        const batch = ids.slice(i, i + MESSAGE_FETCH_CONCURRENCY);
        results.push(...(await Promise.all(batch.map((id) => getMessage(id)))));
      }
      pageToken = page.nextPageToken;
    } while (pageToken && results.length < limit);

    return results;
  }

  return {
    info: {
      key: 'gmail',
      displayName: 'Gmail',
      kind: 'email',
      isLive: true,
      authType: 'oauth2',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    },

    async isConnected() {
      try {
        await getAccessToken();
        return true;
      } catch {
        return false;
      }
    },

    searchMessages,
    getMessage,
    getAttachment,
  };
}
