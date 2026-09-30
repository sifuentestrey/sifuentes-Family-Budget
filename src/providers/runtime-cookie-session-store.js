/**
 * Ephemeral cookie storage for user-triggered provider syncs.
 *
 * Browser-exported cookies are credentials. They belong in a short-lived
 * process closure, not localStorage, Postgres, logs, analytics, or source
 * control. This store deliberately exposes only a URL-scoped Cookie header to
 * a provider and a redacted status object to the UI.
 *
 * A single store can contain cookies for several approved hosts (for example
 * MyTHR and UKG) without ever sending one site's cookies to the other. Notes
 * integrations can use a separate store instance so replacing an HR session
 * cannot disturb the existing notes getter.
 */

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_COOKIES = 200;
const MAX_COOKIE_BYTES = 16 * 1024;

/**
 * @param {object} options
 * @param {string[]} options.allowedHosts exact hosts or parent domains
 * @param {number} [options.ttlMs]
 * @param {() => number} [options.now]
 */
export function createRuntimeCookieSessionStore(options = {}) {
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
  const ttlMs = positiveNumber(options.ttlMs, DEFAULT_TTL_MS);
  const now = typeof options.now === 'function' ? options.now : Date.now;

  /** @type {Array<object>} */
  let cookies = [];
  let receivedAt = 0;
  let expiresAt = 0;

  function clear() {
    cookies = [];
    receivedAt = 0;
    expiresAt = 0;
  }

  return {
    /**
     * Replace the current credentials. Accepts a browser-export array or its
     * JSON string, but never retains the caller's original object.
     */
    set(input) {
      const parsed = parseCookieExport(input);
      if (parsed.length > MAX_COOKIES) throw new Error(`cookie export exceeds ${MAX_COOKIES} entries`);

      const accepted = parsed.map(normalizeCookie).filter((cookie) => {
        const host = cookie.domain.replace(/^\./, '');
        return allowedHosts.some((allowed) => domainMatches(host, allowed));
      });

      const byteSize = accepted.reduce(
        (total, cookie) => total + cookie.name.length + cookie.value.length + 2,
        0,
      );
      if (byteSize > MAX_COOKIE_BYTES) {
        throw new Error(`cookie export exceeds ${MAX_COOKIE_BYTES} bytes`);
      }
      if (!accepted.length) throw new Error('cookie export contains no cookies for an allowed host');

      cookies = accepted.map((cookie) => ({ ...cookie }));
      receivedAt = now();
      expiresAt = receivedAt + ttlMs;
      return this.status();
    },

    /**
     * Return a Cookie header scoped to one HTTPS provider URL.
     * @param {{url?: string}|string} [input]
     */
    get(input = {}) {
      if (!cookies.length || now() >= expiresAt) {
        clear();
        return null;
      }

      const rawUrl = typeof input === 'string' ? input : input?.url;
      if (!rawUrl) throw new Error('sessionStore.get requires a provider URL');
      const url = new URL(rawUrl);
      if (url.protocol !== 'https:') throw new Error('session cookies require HTTPS');
      if (!allowedHosts.some((allowed) => domainMatches(url.hostname, allowed))) {
        throw new Error(`session cookies are not allowed for ${url.hostname}`);
      }

      const currentSeconds = Math.floor(now() / 1000);
      const header = cookies
        .filter((cookie) => cookieMatches(cookie, url, currentSeconds))
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join('; ');
      return header || null;
    },

    clear,

    /** Redacted connection state; cookie names and values are intentionally absent. */
    status() {
      const active = cookies.length > 0 && now() < expiresAt;
      return {
        active,
        cookieCount: active ? cookies.length : 0,
        receivedAt: active ? new Date(receivedAt).toISOString() : null,
        expiresAt: active ? new Date(expiresAt).toISOString() : null,
      };
    },
  };
}

function parseCookieExport(input) {
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      throw new Error('cookie export must be valid JSON');
    }
  }
  if (!Array.isArray(input)) throw new Error('cookie export must be an array');
  return input;
}

function normalizeCookie(raw) {
  const name = String(raw?.name ?? '').trim();
  const value = String(raw?.value ?? '');
  const domain = String(raw?.domain ?? '').trim().toLowerCase();
  if (!name || !domain) throw new Error('each cookie requires name and domain');
  if (/\r|\n|;/.test(name) || /\r|\n/.test(value)) throw new Error('cookie contains unsafe characters');

  return {
    name,
    value,
    domain,
    hostOnly: Boolean(raw.hostOnly),
    path: String(raw.path || '/'),
    secure: raw.secure !== false,
    expirationDate: Number.isFinite(Number(raw.expirationDate))
      ? Number(raw.expirationDate)
      : null,
  };
}

function cookieMatches(cookie, url, currentSeconds) {
  const cookieHost = cookie.domain.replace(/^\./, '');
  const hostMatches = cookie.hostOnly
    ? url.hostname === cookieHost
    : domainMatches(url.hostname, cookieHost);
  if (!hostMatches || !url.pathname.startsWith(cookie.path)) return false;
  if (cookie.secure && url.protocol !== 'https:') return false;
  return cookie.expirationDate == null || cookie.expirationDate > currentSeconds;
}

function normalizeAllowedHosts(input) {
  if (!Array.isArray(input) || !input.length) throw new Error('allowedHosts is required');
  return input.map((host) => String(host).trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
}

function domainMatches(host, allowed) {
  return host === allowed || host.endsWith(`.${allowed}`);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
