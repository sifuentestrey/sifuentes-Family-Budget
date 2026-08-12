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
  domainForPayee, domainInText, faviconUrl, MERCHANT_DOMAINS,
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
  assert.equal(domainForPayee('BERTELLI FARMS #1425'), null);
  assert.equal(domainForPayee('VENMO *JORDAN ELLIS'), 'venmo.com', 'the processor itself is known');
  assert.equal(domainForPayee(''), null);
  assert.equal(domainForPayee('POS 4471'), null, 'nothing distinctive to match on');
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
