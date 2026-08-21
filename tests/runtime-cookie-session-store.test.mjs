import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeCookieSessionStore } from '../src/providers/runtime-cookie-session-store.js';

function cookie(overrides = {}) {
  return {
    name: 'PS_TOKEN',
    value: 'secret-value',
    domain: '.mythr.org',
    path: '/',
    secure: true,
    httpOnly: true,
    ...overrides,
  };
}

test('keeps imported cookies in memory and exposes only redacted status', () => {
  let clock = Date.parse('2026-08-15T12:00:00Z');
  const store = createRuntimeCookieSessionStore({
    allowedHosts: ['mythr.org', 'prd.mykronos.com'],
    ttlMs: 60_000,
    now: () => clock,
  });

  const status = store.set(JSON.stringify([cookie()]));
  assert.equal(status.active, true);
  assert.equal(status.cookieCount, 1);
  assert.equal(JSON.stringify(status).includes('secret-value'), false);
  assert.equal(JSON.stringify(status).includes('PS_TOKEN'), false);

  assert.equal(
    store.get({ url: 'https://hr.mythr.org/psc/payroll' }),
    'PS_TOKEN=secret-value',
  );

  clock += 60_000;
  assert.equal(store.get({ url: 'https://hr.mythr.org/psc/payroll' }), null);
  assert.equal(store.status().active, false);
});

test('never sends MyTHR cookies to UKG or another host', () => {
  const store = createRuntimeCookieSessionStore({
    allowedHosts: ['mythr.org', 'prd.mykronos.com'],
  });
  store.set([
    cookie(),
    cookie({ name: 'UKG_SESSION', value: 'ukg-only', domain: 'texashealth-ss3.prd.mykronos.com', hostOnly: true }),
  ]);

  assert.equal(store.get({ url: 'https://texashealth-ss3.prd.mykronos.com/timekeeping' }), 'UKG_SESSION=ukg-only');
  assert.throws(() => store.get({ url: 'https://attacker.example/' }), /not allowed/);
  assert.throws(() => store.get({ url: 'http://hr.mythr.org/' }), /HTTPS/);
});

test('filters expired cookies, path mismatches, and unapproved domains', () => {
  const now = Date.parse('2026-08-15T12:00:00Z');
  const store = createRuntimeCookieSessionStore({ allowedHosts: ['mythr.org'], now: () => now });
  store.set([
    cookie({ name: 'active', value: 'yes' }),
    cookie({ name: 'expired', value: 'no', expirationDate: now / 1000 - 1 }),
    cookie({ name: 'pay-only', value: 'yes', path: '/psc/payroll' }),
    cookie({ name: 'ignored', value: 'no', domain: '.example.com' }),
  ]);

  assert.equal(store.get({ url: 'https://hr.mythr.org/psc/payroll/history' }), 'active=yes; pay-only=yes');
  assert.equal(store.get({ url: 'https://hr.mythr.org/home' }), 'active=yes');
});

test('rejects malformed or header-injection cookie exports', () => {
  const store = createRuntimeCookieSessionStore({ allowedHosts: ['mythr.org'] });
  assert.throws(() => store.set('not json'), /valid JSON/);
  assert.throws(() => store.set({}), /array/);
  assert.throws(() => store.set([cookie({ value: 'bad\r\nHeader: value' })]), /unsafe/);
  assert.throws(() => store.set([cookie({ domain: '.example.com' })]), /no cookies/);
});
