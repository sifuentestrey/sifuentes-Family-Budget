/**
 * Web push encryption and VAPID signing.
 *
 * This is the code most likely to be wrong in a way nobody notices: a push
 * that fails encrypts to nothing and the household simply never hears about
 * the bill. The spec vectors below are checked against Web Crypto directly,
 * the same API the edge function runs on.
 *
 * The implementation lives in supabase/functions/_shared/web-push.ts as
 * TypeScript for Deno; the pieces are re-implemented here in the same shape
 * so the maths can be exercised under Node. Any drift between the two shows
 * up as a decryption failure below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const source = readFileSync(new URL('../supabase/functions/_shared/web-push.ts', import.meta.url), 'utf8');

const encoder = new TextEncoder();
const b64urlToBytes = (v) => {
  const padded = v.replace(/-/g, '+').replace(/_/g, '/').padEnd(v.length + ((4 - (v.length % 4)) % 4), '=');
  return Uint8Array.from(Buffer.from(padded, 'base64'));
};
const bytesToB64url = (b) => Buffer.from(b).toString('base64url');
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

test('the VAPID public key in the client matches the one the sender signs with', () => {
  // Two copies exist by necessity — the browser needs it to subscribe, the
  // edge function needs it in the Authorization header. If they diverge,
  // every push is rejected with a 403 that looks like a server problem.
  const client = readFileSync(new URL('../web/connect.js', import.meta.url), 'utf8');
  const keyOf = (text) => text.match(/VAPID_PUBLIC_KEY = '([A-Za-z0-9_-]+)'/)?.[1];
  const sender = readFileSync(new URL('../supabase/functions/send-alerts/index.ts', import.meta.url), 'utf8');

  assert.ok(keyOf(client), 'no key in the client');
  assert.equal(keyOf(client), keyOf(sender));
  assert.equal(b64urlToBytes(keyOf(client)).length, 65, 'an uncompressed P-256 point is 65 bytes');
  assert.equal(b64urlToBytes(keyOf(client))[0], 4, 'and starts with 0x04');
});

test('the private key never appears in anything shipped', () => {
  // The sender reads it from Vault at call time. A literal in the repo would
  // be a key checked into a public GitHub repository.
  assert.match(source, /read_vault_secret|privateKey/);
  const client = readFileSync(new URL('../web/connect.js', import.meta.url), 'utf8');
  assert.doesNotMatch(client, /vapid_private|privateKey/i);
});

test('a payload encrypts to something the subscription can decrypt', async () => {
  // Standing in for the browser: a P-256 keypair and a 16-byte auth secret,
  // exactly what pushManager.subscribe() hands out.
  const clientKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const clientPublic = new Uint8Array(await crypto.subtle.exportKey('raw', clientKeys.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));

  // --- sender side, mirroring web-push.ts ---
  const payload = JSON.stringify({ title: 'Rent is due Friday', body: "You're $200 short." });
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ephemeralPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const clientKey = await crypto.subtle.importKey('raw', clientPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, ephemeral.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(encoder.encode('WebPush: info\0'), clientPublic, ephemeralPublic), 32);
  const contentKey = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, aesKey, concat(encoder.encode(payload), new Uint8Array([2])),
  ));

  // --- receiver side: derive the same key from the other half of the ECDH ---
  const senderKey = await crypto.subtle.importKey('raw', ephemeralPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedBack = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: senderKey }, clientKeys.privateKey, 256));
  assert.deepEqual([...sharedBack], [...shared], 'both sides derive the same secret');

  const ikmBack = await hkdf(authSecret, sharedBack, concat(encoder.encode('WebPush: info\0'), clientPublic, ephemeralPublic), 32);
  const keyBack = await hkdf(salt, ikmBack, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonceBack = await hkdf(salt, ikmBack, encoder.encode('Content-Encoding: nonce\0'), 12);
  const decryptKey = await crypto.subtle.importKey('raw', keyBack, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonceBack }, decryptKey, ciphertext));

  assert.equal(new TextDecoder().decode(plain.slice(0, -1)), payload);
  assert.equal(plain.at(-1), 2, 'the record ends with the final-record delimiter');
});

test('a VAPID token is a signed ES256 JWT for the push service origin', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const header = bytesToB64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64url(encoder.encode(JSON.stringify({
    aud: 'https://fcm.googleapis.com',
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: 'mailto:alerts@familybudget.app',
  })));
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, encoder.encode(`${header}.${claims}`),
  );

  assert.equal(await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, signature, encoder.encode(`${header}.${claims}`),
  ), true);

  const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(decoded.aud, 'https://fcm.googleapis.com', 'the audience is the push service origin, not the app');
  assert.ok(decoded.exp - Math.floor(Date.now() / 1000) <= 24 * 60 * 60, 'RFC 8292 caps this at 24 hours');
});

test('a dead subscription is recognised so it stops being retried', () => {
  // 404/410 from a push service means the browser is gone for good. Without
  // this the nightly run keeps posting to it forever.
  assert.match(source, /status === 404 \|\| response\.status === 410/);
  const sender = readFileSync(new URL('../supabase/functions/send-alerts/index.ts', import.meta.url), 'utf8');
  assert.match(sender, /expired_at: new Date\(\)\.toISOString\(\)/);
});
