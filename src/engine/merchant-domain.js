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
 *   3. The table below, matched against the payee with its spaces and
 *      punctuation removed, for chains a bank statement mangles beyond
 *      recognition: "SQ *BLUE BOTTLE", "TST* CHIPOTLE 2245", "CHIK FIL A",
 *      "AMZN Mktp US*RT4G59DK3", "ACH DEBIT PGE WEB ONLINE".
 *
 * There used to be a fourth: a domain guessed from the merchant's own name,
 * on the theory that a wrong guess would land on a domain that doesn't
 * resolve and quietly fall back to the initial. In practice a guessed name
 * usually IS registered — parked, for sale, or an unrelated business — and
 * the logo services answer those with a generic globe rather than a 404. The
 * result was rows of identical globes, which is worse than a letter: a letter
 * says "we don't know this merchant", a globe says "here is its logo" and is
 * lying. So the rule is now simply: show a logo only where the brand is
 * actually known, and a coloured initial everywhere else.
 */

import { payeeStem } from './similar-payee.js';

/** stem -> domain. Lowercase keys, matched against the payee's leading word. */
export const MERCHANT_DOMAINS = {
  // Groceries and warehouse
  safeway: 'safeway.com', kroger: 'kroger.com', albertsons: 'albertsons.com',
  costco: 'costco.com', publix: 'publix.com', aldi: 'aldi.us', wegmans: 'wegmans.com',
  sprouts: 'sprouts.com', heb: 'heb.com', meijer: 'meijer.com',
  instacart: 'instacart.com', walmart: 'walmart.com', target: 'target.com',
  vons: 'vons.com', ralphs: 'ralphs.com',

  // Restaurants, coffee, delivery
  starbucks: 'starbucks.com', chipotle: 'chipotle.com', panera: 'panera.com',
  subway: 'subway.com', dunkin: 'dunkindonuts.com',
  doordash: 'doordash.com', grubhub: 'grubhub.com', postmates: 'postmates.com',
  chickfila: 'chick-fil-a.com', wendys: 'wendys.com', peets: 'peets.com',
  kfc: 'kfc.com', arbys: 'arbys.com', hardees: 'hardees.com',
  sbarro: 'sbarro.com', qdoba: 'qdoba.com', moes: 'moes.com',

  // Fuel and transport
  shell: 'shell.com', chevron: 'chevron.com', exxon: 'exxon.com',
  mobil: 'exxon.com', arco: 'arco.com', valero: 'valero.com',
  speedway: 'speedway.com', wawa: 'wawa.com',
  uber: 'uber.com', lyft: 'lyft.com', bart: 'bart.gov',

  // Shopping and general
  amazon: 'amazon.com', amzn: 'amazon.com', ebay: 'ebay.com', etsy: 'etsy.com',
  ikea: 'ikea.com', wayfair: 'wayfair.com', lowes: 'lowes.com',
  homedepot: 'homedepot.com', rei: 'rei.com', nordstrom: 'nordstrom.com', macys: 'macys.com',
  petco: 'petco.com', petsmart: 'petsmart.com', chewy: 'chewy.com',

  // Pharmacy and health
  cvs: 'cvs.com', walgreens: 'walgreens.com', kaiser: 'kp.org', labcorp: 'labcorp.com',

  // Subscriptions and services
  netflix: 'netflix.com', spotify: 'spotify.com', hulu: 'hulu.com',
  disney: 'disneyplus.com', google: 'google.com',
  microsoft: 'microsoft.com', adobe: 'adobe.com', dropbox: 'dropbox.com',
  audible: 'audible.com', peloton: 'onepeloton.com', equinox: 'equinox.com', nytimes: 'nytimes.com', patreon: 'patreon.com',
  openai: 'openai.com', anthropic: 'anthropic.com',

  // Utilities, telecom, insurance, finance
  comcast: 'xfinity.com', xfinity: 'xfinity.com', verizon: 'verizon.com',
  tmobile: 't-mobile.com', sprint: 't-mobile.com', spectrum: 'spectrum.com',
  geico: 'geico.com', progressive: 'progressive.com', allstate: 'allstate.com',
  statefarm: 'statefarm.com', usaa: 'usaa.com', amex: 'americanexpress.com', venmo: 'venmo.com',
  paypal: 'paypal.com', cashapp: 'cash.app', zelle: 'zellepay.com',
  pge: 'pge.com', pgande: 'pge.com',
  sdge: 'sdge.com', socalgas: 'socalgas.com', conedison: 'coned.com', recology: 'recology.com', att: 'att.com',
  directv: 'directv.com', adt: 'adt.com',

  // More of everyday life
  michaels: 'michaels.com', joann: 'joann.com', staples: 'staples.com',
  autozone: 'autozone.com', napa: 'napaonline.com',
  enterprise: 'enterprise.com', hertz: 'hertz.com', southwest: 'southwest.com', marriott: 'marriott.com', hilton: 'hilton.com',
  airbnb: 'airbnb.com', booking: 'booking.com', expedia: 'expedia.com',
  ticketmaster: 'ticketmaster.com',
  nintendo: 'nintendo.com', playstation: 'playstation.com',
  xbox: 'xbox.com', roblox: 'roblox.com', sephora: 'sephora.com',
  ulta: 'ulta.com', supercuts: 'supercuts.com', popeyes: 'popeyes.com', culvers: 'culvers.com',
  ihop: 'ihop.com', outback: 'outback.com',
  safeco: 'safeco.com', aetna: 'aetna.com', cigna: 'cigna.com',
  anthem: 'anthem.com', fidelity: 'fidelity.com', vanguard: 'vanguard.com', schwab: 'schwab.com',
  robinhood: 'robinhood.com', coinbase: 'coinbase.com', synchrony: 'synchrony.com', navient: 'navient.com', nelnet: 'nelnet.com',
  carmax: 'carmax.com', carvana: 'carvana.com',
  tesla: 'tesla.com', subaru: 'subaru.com', chevrolet: 'chevrolet.com',
};

/**
 * Brands matched against the payee with every space and separator removed,
 * so a bank's spelling can't hide them: "CHIK FIL A", "Chick-Fil-A #1220"
 * and "CHICKFILA" are all the same nine letters once compacted.
 *
 * Longest key wins, so "jackinthebox" is never shadowed by a shorter key
 * that happens to sit inside it.
 */
export const BRAND_KEYS = {
  chickfila: 'chick-fil-a.com', chikfila: 'chick-fil-a.com',
  jackinthebox: 'jackinthebox.com', wingstop: 'wingstop.com',
  cicispizza: 'cicispizza.com',
  littlecaesars: 'littlecaesars.com', whataburger: 'whataburger.com',
  dairyqueen: 'dairyqueen.com', elpolloloco: 'elpolloloco.com',
  tacocabana: 'tacocabana.com', zaxbys: 'zaxbys.com',
  bojangles: 'bojangles.com', chilis: 'chilis.com',
  applebees: 'applebees.com', reddobster: 'redlobster.com',
  redlobster: 'redlobster.com', texasroadhouse: 'texasroadhouse.com',
  longhorn: 'longhornsteakhouse.com', chuckecheese: 'chuckecheese.com',
  freddys: 'freddys.com', portillos: 'portillos.com', innout: 'in-n-out.com',
  torchys: 'torchystacos.com', jimmyjohns: 'jimmyjohns.com',
  firehouse: 'firehousesubs.com', potbelly: 'potbelly.com',
  smoothieking: 'smoothieking.com', jambajuice: 'jamba.com',
  dutchbros: 'dutchbros.com', scooters: 'scooterscoffee.com',
  bigblue: 'bigbluebagels.com', crumbl: 'crumblcookies.com',
  sonicdrivein: 'sonicdrivein.com', carlsjr: 'carlsjr.com',
  deltaco: 'deltaco.com',
  familydollar: 'familydollar.com', dollartree: 'dollartree.com',
  dollargeneral: 'dollargeneral.com', tjmaxx: 'tjmaxx.com',
  marshalls: 'marshalls.com', rossstores: 'ross.com',
  homegoods: 'homegoods.com', bathbody: 'bathandbodyworks.com',
  academysports: 'academy.com', dickssporting: 'dickssportinggoods.com',
  harborfreight: 'harborfreight.com', tractorsupply: 'tractorsupply.com',
  oreilly: 'oreillyauto.com', advanceauto: 'advanceautoparts.com',
  circlek: 'circlek.com', quiktrip: 'quiktrip.com', racetrac: 'racetrac.com',
  buccees: 'buc-ees.com', pilotflying: 'pilotflyingj.com',
  lovestravel: 'loves.com', seveneleven: '7-eleven.com',
  fidelity: 'fidelity.com',

  // Moved here from the single-word table: each of these is the first word of
  // a longer brand, so as a single token it would brand any merchant that
  // happens to start the same way — "Del Taco" as Taco Bell, "Best Western"
  // as Best Buy, "Family Dentistry" as Dollar General.
  alaskaair: 'alaskaair.com',
  allybank: 'ally.com',
  amctheatres: 'amctheatres.com',
  americanairlines: 'aa.com',
  applemusic: 'apple.com', applecom: 'apple.com',
  bestbuy: 'bestbuy.com',
  brighthorizons: 'brighthorizons.com',
  buffalowildwings: 'buffalowildwings.com',
  capitalone: 'capitalone.com',
  chasecredit: 'chase.com', chasebank: 'chase.com',
  thecheesecakefactory: 'thecheesecakefactory.com',
  citibank: 'citi.com', citicard: 'citi.com',
  coxcomm: 'cox.com', coxcable: 'cox.com',
  crackerbarrel: 'crackerbarrel.com',
  deltaairlines: 'delta.com', deltaair: 'delta.com',
  deltadental: 'deltadental.com',
  dennys: 'dennys.com',
  discounttire: 'discounttire.com',
  discover: 'discover.com',
  dishnetwork: 'dish.com',
  dollartree: 'dollartree.com',
  dominionenergy: 'dominionenergy.com',
  dominos: 'dominos.com',
  dukeenergy: 'duke-energy.com',
  socaledison: 'sce.com',
  dollargeneral: 'dollargeneral.com',
  farmers: 'farmers.com',
  firestonecompleteautocare: 'firestonecompleteautocare.com',
  fivebelow: 'fivebelow.com',
  fiveguys: 'fiveguys.com',
  fordcredit: 'ford.com', fordmotor: 'ford.com',
  frontier: 'frontier.com',
  greatclips: 'greatclips.com',
  homedepot: 'homedepot.com',
  hondafinancial: 'honda.com', americanhonda: 'honda.com',
  jerseymikes: 'jerseymikes.com',
  jiffylube: 'jiffylube.com',
  jimmyjohns: 'jimmyjohns.com',
  libertymutual: 'libertymutual.com',
  marathonbrand: 'marathonbrand.com',
  mcdonalds: 'mcdonalds.com',
  nationwide: 'nationwide.com',
  officedepot: 'officedepot.com',
  olivegarden: 'olivegarden.com',
  pandaexpress: 'pandaexpress.com',
  papajohns: 'papajohns.com',
  planetfitness: 'planetfitness.com',
  questdiagnostics: 'questdiagnostics.com',
  raisingcanes: 'raisingcanes.com',
  regmovies: 'regmovies.com',
  ringcom: 'ring.com',
  riteaid: 'riteaid.com',
  salliemae: 'salliemae.com',
  shakeshack: 'shakeshack.com',
  sonicdrivein: 'sonicdrivein.com',
  steampowered: 'steampowered.com',
  tacobell: 'tacobell.com',
  toyota: 'toyota.com',
  traderjoes: 'traderjoes.com',
  united: 'united.com',
  unitedhealthcare: 'uhc.com', unitedhealth: 'uhc.com',
  wastemanagement: 'wm.com',
  wellsfargo: 'wellsfargo.com',
  wholefoodsmarket: 'wholefoodsmarket.com', wholefoods: 'wholefoodsmarket.com',
};

/**
 * Words that are a category rather than a company, so treating one as a
 * brand lands on somebody unrelated. "MEDICAL GROUP OF X" must not become
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

  // Last: brands that only appear once the bank's spacing is removed.
  const compact = compactName(cleaned || payee);
  if (compact) {
    for (const key of BRAND_KEYS_BY_LENGTH) {
      if (compact.includes(key)) return BRAND_KEYS[key];
    }
  }

  // Nothing recognised it. That is a complete answer: the row keeps its
  // coloured initial rather than being given a logo nobody can vouch for.
  return null;
}

/** Words a bank appends that are never part of the merchant's name. */
const NAME_NOISE = new Set([
  'llc', 'inc', 'corp', 'co', 'ltd', 'lp', 'plc', 'the', 'and', 'of',
  'web', 'pmt', 'pymt', 'bill', 'billpay', 'online', 'recurring', 'auto',
  'ach', 'pos', 'debit', 'credit', 'purchase', 'payment', 'store', 'grp',
  'group', 'usa', 'us', 'intl', 'international',
]);

/** A payee with every space, digit and separator removed. */
export function compactName(payee) {
  return String(payee ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

/** Longest first, so a short key never shadows the brand containing it. */
const BRAND_KEYS_BY_LENGTH = Object.keys(BRAND_KEYS).map((k) => k.toLowerCase())
  .sort((a, b) => b.length - a.length);

/** Words in a payee that carry meaning: no noise, no one/two-letter scraps. */
function meaningfulWords(payee) {
  return String(payee ?? '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !NAME_NOISE.has(w));
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
