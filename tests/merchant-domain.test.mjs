/**
 * Merchant → domain, for logos.
 *
 * A wrong logo is worse than no logo — it makes the whole list untrustworthy,
 * and the person scanning for a charge they don't recognise is exactly the one
 * who must not be shown the wrong brand. So most of these are about refusing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  domainForPayee, domainInText, faviconUrl, guessedDomain, logoSources, MERCHANT_DOMAINS,
} from '../src/engine/merchant-domain.js';

test('a website from Plaid wins over everything else', () => {
  assert.equal(
    domainForPayee('SQ *BLUE BOTTLE COFFEE #4412', 'https://bluebottlecoffee.com/shop'),
    'bluebottlecoffee.com',
  );
});

test('a domain sitting in the payee text is used', () => {
  assert.equal(domainInText('WWW.PGE.COM PMT'), 'pge.com');
  assert.equal(domainInText('COMCAST.COM BILL PAY'), 'comcast.com');
  assert.equal(domainInText('SAFEWAY #1425'), null, 'a store number is not a domain');
  assert.equal(domainInText('PAYMENT 4021.50'), null, 'an amount is not a domain');
});

test('processor prefixes are stripped before matching the merchant', () => {
  // These prefixes are the single most common reason a payee is unrecognisable.
  assert.equal(domainForPayee('SQ *STARBUCKS 4412'), 'starbucks.com');
  assert.equal(domainForPayee('TST* CHIPOTLE 2245'), 'chipotle.com');
  assert.equal(domainForPayee('AMZN Mktp US*RT4G59DK3'), 'amazon.com');
});

test('an unknown merchant gets no logo rather than a wrong one', () => {
  assert.equal(domainForPayee('POS 4471'), null, 'nothing to identify');
  assert.equal(domainForPayee('VENMO *JORDAN ELLIS'), 'venmo.com', 'the processor itself is known');
  assert.equal(domainForPayee(''), null);
});

test('every domain in the table looks like a hostname', () => {
  for (const [stem, domain] of Object.entries(MERCHANT_DOMAINS)) {
    assert.match(domain, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, `${stem} -> ${domain} is not a hostname`);
    assert.equal(stem, stem.toLowerCase(), `${stem} must be lowercase to ever match a stem`);
    assert.ok(stem.length >= 3, `${stem} is too short to identify a merchant`);
  }
});

test('the favicon URL escapes what it is given, and refuses nothing', () => {
  assert.equal(faviconUrl(null), null);
  assert.match(faviconUrl('costco.com'), /^https:\/\/www\.google\.com\/s2\/favicons\?domain=costco\.com&sz=64$/);
  assert.ok(!faviconUrl('a b&c=d').includes(' '), 'an unescaped domain would break the URL');
});

test('a known chain is found even when the bank buries it mid-description', () => {
  assert.equal(domainForPayee('ACH DEBIT PG&E WEB ONLINE'), 'pge.com');
  assert.equal(domainForPayee('POS DEBIT 07/11 TRADER JOES #123'), 'traderjoes.com');
  assert.equal(domainForPayee('COMCAST XFINITY WEB PMT'), 'xfinity.com');
  assert.equal(domainForPayee('CVS/PHARMACY #08812'), 'cvs.com', 'short names must not be lost');
  assert.equal(domainForPayee('REI #0021 SEATTLE WA'), 'rei.com');
});

test('a local business is guessed from its own name, not from the noise around it', () => {
  // The words a bank puts in front of the name are the ones that must not
  // end up in the domain.
  assert.equal(domainForPayee('RENT PAYMENT OAKWOOD PROPERTIES'), 'oakwoodproperties.com');
  assert.equal(domainForPayee('DIRECT DEP NORTHSTAR LOGISTICS PAYROLL'), 'northstarlogistics.com');
});

test('guessing refuses when it would land on a category noun or a bare word', () => {
  // "MEDICAL GROUP OF BERKELEY" must never become medical.com or berkeley.com —
  // both are real sites belonging to somebody else entirely.
  assert.equal(domainForPayee('MEDICAL GROUP OF BERKELEY'), null);
  assert.equal(domainForPayee('ONLINE TRANSFER TO SAVINGS 7788'), null);
  assert.equal(guessedDomain('PHARMACY'), null, 'one generic word is nothing to go on');
  assert.equal(guessedDomain('ORTHODONTICS'), null, 'a single word is never enough');
});

test('a logo has more than one place it can come from', () => {
  // One host being blocked — by a content blocker, a filtering DNS, a captive
  // network — strips the logos off the entire list at once, which reads as a
  // broken feature rather than a blocked one. A second host makes that
  // "logos, slightly later".
  const sources = logoSources('costco.com');
  assert.equal(sources.length, 2);
  assert.ok(sources.every((u) => u.startsWith('https://')));
  const hosts = sources.map((u) => new URL(u).host);
  assert.equal(new Set(hosts).size, 2, 'two sources on the same host is one source');
  assert.ok(sources.every((u) => u.includes('costco.com')));
});

test('no domain means no sources, not a broken URL', () => {
  assert.deepEqual(logoSources(null), []);
  assert.deepEqual(logoSources(''), []);
  assert.equal(faviconUrl(null), null);
});

test('every source escapes the domain it is given', () => {
  for (const url of logoSources('a b&c=d')) {
    assert.ok(!url.includes(' '), `unescaped space in ${url}`);
    assert.ok(!/[?&]c=d/.test(url), `unescaped separator in ${url}`);
  }
});
