/**
 * Web push, hand-rolled against Web Crypto.
 *
 * Two specs, both small enough to implement directly and both worth
 * understanding, since a push that silently fails is indistinguishable from
 * a household that has nothing to be alerted about:
 *
 *   RFC 8291 (message encryption) — the payload is encrypted toward the
 *   subscription's own public key, so the push service relays bytes it
 *   cannot read. That is the whole reason this can't be a plain POST.
 *
 *   RFC 8292 (VAPID) — a short-lived ES256 JWT identifying this application
 *   to the push service, signed with the private key held in Vault. Its
 *   public half ships in the client and is not secret.
 *
 * Deliberately no npm dependency. The two libraries that do this pull in
 * Node's crypto through Deno's compatibility layer, and a compat break at
 * 09:30 UTC silently stops every reminder the household relies on.
 */

const encoder = new TextEncoder();

function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function bytesToB64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** HKDF, the one-shot form RFC 8291 uses. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * The VAPID JWT: audience is the push service's origin, expiry is short, and
 * the subject is a contact address the service can complain to.
 */
async function vapidToken(audience: string, privateJwkD: string, publicKey: string, subject: string) {
  const header = bytesToB64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64url(encoder.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  })));
  const signingInput = `${header}.${claims}`;

  const pub = b64urlToBytes(publicKey);
  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: privateJwkD,
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${bytesToB64url(signature)}`;
}

/** RFC 8291 aes128gcm encryption toward one subscription. */
async function encryptPayload(payload: string, p256dh: string, authSecret: string) {
  const clientPublic = b64urlToBytes(p256dh);
  const auth = b64urlToBytes(authSecret);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // An ephemeral keypair per message: the shared secret must never repeat.
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  ) as CryptoKeyPair;
  const ephemeralPublic = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeral.publicKey),
  );

  const clientKey = await crypto.subtle.importKey(
    'raw', clientPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, ephemeral.privateKey, 256),
  );

  const prkInfo = concat(
    encoder.encode('WebPush: info\0'), clientPublic, ephemeralPublic,
  );
  const ikm = await hkdf(auth, shared, prkInfo, 32);
  const contentKey = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);
  // The padding delimiter 0x02 marks the final (only) record.
  const plaintext = concat(encoder.encode(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext),
  );

  // aes128gcm header: salt | record size | key id length | key id
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([ephemeralPublic.length]), ephemeralPublic, ciphertext);
}

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Send one notification.
 *
 * `gone` in the result means the push service says this subscription no
 * longer exists — an uninstalled app, a cleared browser. The caller marks it
 * expired rather than retrying it every night forever.
 */
export async function sendPush(
  subscription: PushSubscriptionRow,
  payload: unknown,
  vapid: { publicKey: string; privateKey: string; subject: string },
): Promise<{ ok: boolean; status: number; gone: boolean; error?: string }> {
  const audience = new URL(subscription.endpoint).origin;
  const [jwt, body] = await Promise.all([
    vapidToken(audience, vapid.privateKey, vapid.publicKey, vapid.subject),
    encryptPayload(JSON.stringify(payload), subscription.p256dh, subscription.auth),
  ]);

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
    },
    body,
  });

  if (response.ok) return { ok: true, status: response.status, gone: false };
  return {
    ok: false,
    status: response.status,
    gone: response.status === 404 || response.status === 410,
    error: (await response.text().catch(() => '')).slice(0, 200),
  };
}
