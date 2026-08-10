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
 * Gmail sends body parts as base64url, not standard base64, and the payload
 * is UTF-8 — `atob()` alone decodes to a binary string, which mangles any
 * multi-byte character (curly quotes in a statement's boilerplate, an accented
 * name), so the bytes are handed to `TextDecoder` rather than used directly.
 */
export function decodeBase64Url(data) {
  if (!data) return '';
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
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
 * Gmail messages are a MIME tree, not a flat body — a bill with an HTML part
 * and a plain-text fallback nests both under `payload.parts`. Walks it once
 * and keeps the first plain-text and first HTML part found, which is all the
 * parser downstream (`bill-parser.js`) ever looks at.
 */
export function extractBody(payload) {
  if (!payload) return { text: '', html: '' };
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return { text: decodeBase64Url(payload.body.data), html: '' };
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return { text: '', html: decodeBase64Url(payload.body.data) };
  }
  if (payload.parts?.length) {
    let text = '';
    let html = '';
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested.text && !text) text = nested.text;
      if (nested.html && !html) html = nested.html;
    }
    return { text, html };
  }
  return { text: '', html: '' };
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
    const { text, html } = extractBody(message.payload);

    return {
      id: message.id,
      from,
      fromName,
      subject: findHeader(headers, 'Subject'),
      receivedAt: new Date(Number(message.internalDate)).toISOString(),
      bodyText: text || undefined,
      bodyHtml: html || undefined,
    };
  }

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
      for (const { id } of page.messages ?? []) {
        results.push(await getMessage(id));
        if (results.length >= limit) break;
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
  };
}
