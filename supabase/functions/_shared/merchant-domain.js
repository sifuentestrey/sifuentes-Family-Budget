// GENERATED FILE — do not edit.
// Source of truth: src/engine/merchant-domain.js
// Regenerate with: npm run sync:shared
/**
 * Merchant → website domain, so a charge can be shown with the merchant's own
 * logo instead of a coloured initial.
 *
 * Plaid returns a logo and a website for some transactions, but not most: on a
 * typical statement the useful fields are simply absent, and a feature that
 * only works for a third of the rows reads as broken rather than partial. So
 * the domain is derived here, from the payee string itself, and the logo is
 * fetched from that domain's favicon.
 *
 * Three sources, in order of how much they can be trusted:
 *
 *   1. A website Plaid actually gave us.
 *   2. A domain sitting in the payee text — "COMCAST.COM BILL PAY", and the
 *      surprisingly common "WWW.SOMETHING.COM" descriptor.
 *   3. This table, keyed by the payee's leading word (the same stem the
 *      lookalike-categorizer uses), for merchants a bank statement mangles
 *      beyond recognition: "SQ *BLUE BOTTLE", "TST* CHIPOTLE 2245",
 *      "AMZN Mktp US*RT4G59DK3".
 *
 * The table is deliberately small and only holds merchants where the mapping
 * is unambiguous. A wrong logo is worse than no logo: it makes the whole list
 * untrustworthy, and someone scanning for a charge they don't recognise is
 * exactly the person who must not be shown the wrong brand.
 */

import { payeeStem } from './similar-payee.js';

/** stem -> domain. Lowercase keys, matched against the payee's leading word. */
export const MERCHANT_DOMAINS = {
  // Groceries and warehouse
  safeway: 'safeway.com', kroger: 'kroger.com', albertsons: 'albertsons.com',
  costco: 'costco.com', trader: 'traderjoes.com', whole: 'wholefoodsmarket.com',
  publix: 'publix.com', aldi: 'aldi.us', wegmans: 'wegmans.com',
  sprouts: 'sprouts.com', heb: 'heb.com', meijer: 'meijer.com',
  instacart: 'instacart.com', walmart: 'walmart.com', target: 'target.com',
  vons: 'vons.com', ralphs: 'ralphs.com',

  // Restaurants, coffee, delivery
  starbucks: 'starbucks.com', chipotle: 'chipotle.com', panera: 'panera.com',
  mcdonald: 'mcdonalds.com', subway: 'subway.com', dunkin: 'dunkindonuts.com',
  doordash: 'doordash.com', grubhub: 'grubhub.com', postmates: 'postmates.com',
  chickfila: 'chick-fil-a.com', wendys: 'wendys.com', taco: 'tacobell.com',
  domino: 'dominos.com', papa: 'papajohns.com', peets: 'peets.com',

  // Fuel and transport
  shell: 'shell.com', chevron: 'chevron.com', exxon: 'exxon.com',
  mobil: 'exxon.com', arco: 'arco.com', valero: 'valero.com',
  marathon: 'marathonbrand.com', speedway: 'speedway.com', wawa: 'wawa.com',
  uber: 'uber.com', lyft: 'lyft.com', bart: 'bart.gov',

  // Shopping and general
  amazon: 'amazon.com', amzn: 'amazon.com', ebay: 'ebay.com', etsy: 'etsy.com',
  ikea: 'ikea.com', wayfair: 'wayfair.com', lowes: 'lowes.com',
  homedepot: 'homedepot.com', home: 'homedepot.com', best: 'bestbuy.com',
  rei: 'rei.com', nordstrom: 'nordstrom.com', macys: 'macys.com',
  petco: 'petco.com', petsmart: 'petsmart.com', chewy: 'chewy.com',

  // Pharmacy and health
  cvs: 'cvs.com', walgreens: 'walgreens.com', rite: 'riteaid.com',
  kaiser: 'kp.org', quest: 'questdiagnostics.com', labcorp: 'labcorp.com',

  // Subscriptions and services
  netflix: 'netflix.com', spotify: 'spotify.com', hulu: 'hulu.com',
  disney: 'disneyplus.com', apple: 'apple.com', google: 'google.com',
  microsoft: 'microsoft.com', adobe: 'adobe.com', dropbox: 'dropbox.com',
  audible: 'audible.com', peloton: 'onepeloton.com', planet: 'planetfitness.com',
  equinox: 'equinox.com', nytimes: 'nytimes.com', patreon: 'patreon.com',
  openai: 'openai.com', anthropic: 'anthropic.com',

  // Utilities, telecom, insurance, finance
  comcast: 'xfinity.com', xfinity: 'xfinity.com', verizon: 'verizon.com',
  tmobile: 't-mobile.com', sprint: 't-mobile.com', spectrum: 'spectrum.com',
  geico: 'geico.com', progressive: 'progressive.com', allstate: 'allstate.com',
  statefarm: 'statefarm.com', usaa: 'usaa.com', chase: 'chase.com',
  amex: 'americanexpress.com', discover: 'discover.com', capital: 'capitalone.com',
  wells: 'wellsfargo.com', citi: 'citi.com', venmo: 'venmo.com',
  paypal: 'paypal.com', cashapp: 'cash.app', zelle: 'zellepay.com',
  bright: 'brighthorizons.com',
};

/** Payment-processor prefixes that sit in front of the real merchant name. */
const PROCESSOR_PREFIXES = /^(sq|tst|sp|py|pp|par|ci|ach|pos|debit|credit|web|recur|dd)\b[\s*]*/i;

/**
 * A domain sitting in the payee text. Handles "COMCAST.COM BILL PAY" and
 * "WWW.PGE.COM PMT", and refuses anything that isn't shaped like a hostname.
 * @param {string} text
 */
export function domainInText(text) {
  if (!text) return null;
  const match = String(text)
    .toLowerCase()
    .match(/\b((?:[a-z0-9-]+\.)+(?:com|net|org|gov|edu|io|co|us))\b/);
  if (!match) return null;
  return match[1].replace(/^www\./, '');
}

/**
 * Best available domain for a payee.
 *
 * @param {string} payee
 * @param {string|null} [website] - what Plaid said, when it said anything
 * @returns {string|null}
 */
export function domainForPayee(payee, website = null) {
  const fromPlaid = domainInText(website);
  if (fromPlaid) return fromPlaid;

  const inline = domainInText(payee);
  if (inline) return inline;

  // Strip a processor prefix before taking the stem, so "SQ *BLUE BOTTLE"
  // stems to "blue" rather than to the processor.
  const cleaned = String(payee ?? '').replace(PROCESSOR_PREFIXES, '');
  const stem = payeeStem(cleaned) ?? payeeStem(payee);
  if (!stem) return null;

  return MERCHANT_DOMAINS[stem] ?? null;
}

/**
 * Favicon URL for a domain, via Google's public favicon service.
 *
 * The tradeoff, stated plainly because it is a real one: fetching these tells
 * Google which merchant domains this browser is looking up. It is a list of
 * places the household shops, tied to their IP — not their transactions, not
 * their amounts, and not their identity, but not nothing either. The app ships
 * with a switch to turn it off (More → Show merchant logos), and turning it off
 * falls back to coloured initials with no third-party request at all.
 *
 * The alternative was bundling brand images, which means shipping other
 * people's trademarks and going stale the moment a company rebrands.
 */
export function faviconUrl(domain, size = 64) {
  if (!domain) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}
