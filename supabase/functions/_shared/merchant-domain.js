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
 * Four sources, in order of how much they can be trusted:
 *
 *   1. A website Plaid actually gave us.
 *   2. A domain sitting in the payee text — "COMCAST.COM BILL PAY", and the
 *      surprisingly common "WWW.SOMETHING.COM" descriptor.
 *   3. The table below, matched against any meaningful word in the payee, for
 *      chains a bank statement mangles beyond recognition: "SQ *BLUE BOTTLE",
 *      "TST* CHIPOTLE 2245", "AMZN Mktp US*RT4G59DK3", "ACH DEBIT PGE WEB".
 *   4. A domain guessed from the merchant's own name — see guessedDomain.
 *      A table can only ever cover national chains, which on a real statement
 *      is a minority of the rows; the dentist, the daycare and the landlord
 *      are the charges someone actually scans for, and most of them own the
 *      .com of their name.
 *
 * A wrong logo is worse than no logo: it makes the whole list untrustworthy,
 * and someone scanning for a charge they don't recognise is exactly the person
 * who must not be shown the wrong brand. So the guessing rules are built so
 * that being wrong lands on a domain that does not resolve — the logo services
 * answer those with a 404, and the row falls back to its coloured initial.
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
  bright: 'brighthorizons.com', pge: 'pge.com', pgande: 'pge.com',
  sdge: 'sdge.com', socalgas: 'socalgas.com', edison: 'sce.com',
  duke: 'duke-energy.com', conedison: 'coned.com', dominion: 'dominionenergy.com',
  waste: 'wm.com', recology: 'recology.com', att: 'att.com',
  frontier: 'frontier.com', cox: 'cox.com', dish: 'dish.com',
  directv: 'directv.com', ring: 'ring.com', adt: 'adt.com',

  // More of everyday life
  dollar: 'dollartree.com', family: 'dollargeneral.com', five: 'fivebelow.com',
  michaels: 'michaels.com', joann: 'joann.com', staples: 'staples.com',
  office: 'officedepot.com', autozone: 'autozone.com', napa: 'napaonline.com',
  jiffy: 'jiffylube.com', discount: 'discounttire.com', firestone: 'firestonecompleteautocare.com',
  enterprise: 'enterprise.com', hertz: 'hertz.com', delta: 'delta.com',
  united: 'united.com', southwest: 'southwest.com', alaska: 'alaskaair.com',
  american: 'aa.com', marriott: 'marriott.com', hilton: 'hilton.com',
  airbnb: 'airbnb.com', booking: 'booking.com', expedia: 'expedia.com',
  amc: 'amctheatres.com', regal: 'regmovies.com', ticketmaster: 'ticketmaster.com',
  steam: 'steampowered.com', nintendo: 'nintendo.com', playstation: 'playstation.com',
  xbox: 'xbox.com', roblox: 'roblox.com', sephora: 'sephora.com',
  ulta: 'ulta.com', supercuts: 'supercuts.com', great: 'greatclips.com',
  panda: 'pandaexpress.com', shake: 'shakeshack.com', five_guys: 'fiveguys.com',
  jersey: 'jerseymikes.com', jimmy: 'jimmyjohns.com', raising: 'raisingcanes.com',
  popeyes: 'popeyes.com', sonic: 'sonicdrivein.com', culvers: 'culvers.com',
  ihop: 'ihop.com', denny: 'dennys.com', cracker: 'crackerbarrel.com',
  olive: 'olivegarden.com', cheesecake: 'thecheesecakefactory.com',
  buffalo: 'buffalowildwings.com', outback: 'outback.com',
  safeco: 'safeco.com', farmers: 'farmers.com', nationwide: 'nationwide.com',
  liberty: 'libertymutual.com', aetna: 'aetna.com', cigna: 'cigna.com',
  anthem: 'anthem.com', united_health: 'uhc.com', delta_dental: 'deltadental.com',
  fidelity: 'fidelity.com', vanguard: 'vanguard.com', schwab: 'schwab.com',
  robinhood: 'robinhood.com', coinbase: 'coinbase.com', ally: 'ally.com',
  synchrony: 'synchrony.com', navient: 'navient.com', nelnet: 'nelnet.com',
  sallie: 'salliemae.com', carmax: 'carmax.com', carvana: 'carvana.com',
  tesla: 'tesla.com', toyota: 'toyota.com', honda: 'honda.com',
  ford: 'ford.com', subaru: 'subaru.com', chevrolet: 'chevrolet.com',
};

/**
 * Words that are a category rather than a company, so guessing a domain from
 * them lands on somebody unrelated. "MEDICAL GROUP OF X" must not become
 * medical.com.
 */
const GENERIC_WORDS = new Set([
  'medical', 'dental', 'clinic', 'health', 'hospital', 'pharmacy', 'family',
  'city', 'county', 'state', 'water', 'power', 'energy', 'electric', 'gas',
  'auto', 'motor', 'insurance', 'financial', 'capital', 'first', 'national',
  'american', 'united', 'general', 'service', 'services', 'solutions',
  'properties', 'property', 'management', 'rental', 'rentals', 'apartments',
  'grocery', 'grocers', 'foods', 'restaurant', 'cafe', 'coffee', 'bakery',
  'salon', 'barber', 'cleaners', 'laundry', 'daycare', 'childcare', 'academy',
  'school', 'church', 'transfer', 'deposit', 'payroll', 'payment', 'billpay',
  'withdrawal', 'atm', 'check', 'interest', 'fee', 'charge', 'refund',
  'rent', 'mortgage', 'lease', 'utility', 'utilities', 'membership', 'monthly',
  'direct', 'dep', 'purchase', 'debit', 'credit',
]);

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

  // Strip a processor prefix before matching, so "SQ *BLUE BOTTLE" is read as
  // Blue Bottle rather than as the processor.
  // "&" is dropped rather than spaced, so PG&E reads as one word (pge) and
  // matches the table instead of dissolving into two one-letter fragments.
  const cleaned = String(payee ?? '').replace(/&/g, '').replace(PROCESSOR_PREFIXES, '');

  // The table is tried against the first word as well as against the stem:
  // the stem deliberately ignores anything under four characters, which would
  // otherwise lose CVS, REI and IKEA.
  const firstWord = cleaned.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/)[0];
  if (firstWord && MERCHANT_DOMAINS[firstWord]) return MERCHANT_DOMAINS[firstWord];

  const stem = payeeStem(cleaned) ?? payeeStem(payee);
  if (stem && MERCHANT_DOMAINS[stem]) return MERCHANT_DOMAINS[stem];

  // A known merchant anywhere in the description, not only at the front:
  // banks bury the name behind their own prefixes ("ACH DEBIT PGE WEB
  // ONLINE"), and the words in front of it are noise by definition.
  for (const word of meaningfulWords(cleaned || payee)) {
    if (MERCHANT_DOMAINS[word]) return MERCHANT_DOMAINS[word];
  }

  return guessedDomain(cleaned || payee);
}

/** Words in a payee that carry meaning: no noise, no one/two-letter scraps. */
function meaningfulWords(payee) {
  return String(payee ?? '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !NAME_NOISE.has(w));
}

/**
 * A domain guessed from the merchant's own name — "OAKWOOD PROPERTIES" →
 * oakwoodproperties.com, "MERIDIAN HEALTH GRP" → meridianhealth.com.
 *
 * The table above can only ever cover national chains, which on a real
 * statement is a minority of the rows: the dentist, the daycare, the local
 * hardware store and the landlord are all missing from it, and they are
 * exactly the charges someone scans for. Most small businesses do own the
 * .com of their own name, so this is right far more often than not.
 *
 * When it's wrong it is nearly always wrong by landing on a domain that does
 * not exist, and the favicon service answers that with a neutral globe — a
 * "no logo" outcome, not another company's brand. The guards below exist to
 * keep it that way:
 *
 *   - never guess from a single generic word (medical.com, properties.com);
 *   - two words are joined before one is used alone, since "oakwood
 *     properties" is far more identifying than "oakwood";
 *   - noise words a bank appends (LLC, INC, #1425, WEB PMT) are dropped
 *     first, so they never end up inside the guessed hostname.
 */
const NAME_NOISE = new Set([
  'llc', 'inc', 'corp', 'co', 'ltd', 'lp', 'plc', 'the', 'and', 'of',
  'web', 'pmt', 'pymt', 'bill', 'billpay', 'online', 'recurring', 'auto',
  'ach', 'pos', 'debit', 'credit', 'purchase', 'payment', 'store', 'grp',
  'group', 'usa', 'us', 'intl', 'international',
]);

export function guessedDomain(payee) {
  const words = meaningfulWords(payee);

  // Leading category nouns are what a bank puts in front of the actual name
  // ("RENT PAYMENT OAKWOOD PROPERTIES", "MEDICAL GROUP OF BERKELEY"), so
  // drop them — but never the last word, or there is nothing left to guess
  // from and "medical.com" is precisely the wrong answer.
  let start = 0;
  while (start < words.length - 1 && GENERIC_WORDS.has(words[start])) start += 1;

  const [first, second] = words.slice(start);

  // Pairs only. A single word is either a chain already in the table above or
  // too thin to bet a brand on: guessing from one word turns the local
  // "BERKELEY ORTHODONTICS" into berkeley.com, which is somebody else, and
  // "PHARMACY" into pharmacy.com, which is nobody's dentist. The coverage a
  // solo guess would add is not worth a list that shows the wrong brands.
  if (!first || !second) return null;
  return `${first}${second}.com`;
}

/**
 * Where a domain's logo can be fetched from, best first.
 *
 * Two services rather than one, because either can fail for reasons that have
 * nothing to do with the merchant: one 404s for a site the other knows, and
 * both are the kind of host a content blocker or a filtering DNS blocks
 * wholesale — which strips the logos off an entire list at once and looks
 * like the feature is broken rather than blocked. Trying a second host turns
 * that from "no logos anywhere" into "logos, slightly later".
 *
 * Both 404 for a domain they don't know, which is what makes guessing safe:
 * a wrong guess ends as a coloured initial, not as another company's brand.
 *
 * The tradeoff, stated plainly because it is a real one: fetching these tells
 * whichever service answers which merchant domains this browser is looking
 * up. It is a list of places the household shops, tied to their IP — not
 * their transactions, not their amounts, not their identity, but not nothing
 * either. The app ships with a switch (More → Show merchant logos), and off
 * means no third-party request at all.
 *
 * The alternative was bundling brand images, which means shipping other
 * people's trademarks and going stale the moment a company rebrands.
 */
export function logoSources(domain, size = 64) {
  if (!domain) return [];
  const host = encodeURIComponent(domain);
  return [
    `https://www.google.com/s2/favicons?domain=${host}&sz=${size}`,
    `https://icons.duckduckgo.com/ip3/${host}.ico`,
  ];
}

/** The first source, for callers that only want one URL. */
export function faviconUrl(domain, size = 64) {
  return logoSources(domain, size)[0] ?? null;
}
