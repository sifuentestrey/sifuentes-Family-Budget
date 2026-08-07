/**
 * Payee normalization.
 *
 * Bank descriptions are noisy in consistent, well-known ways. Every layer
 * downstream (learned rules, keyword rules, income clustering) keys off the
 * cleaned payee, so this runs first and everything depends on it being stable.
 *
 * The goal is a name a human would recognize:
 *   "SQ *BLUE BOTTLE COFFEE #4412 OAKLAND CA"  ->  "Blue Bottle Coffee"
 *   "POS DEBIT 07/14 TRADER JOES #123"         ->  "Trader Joes"
 *
 * Stability matters more than beauty: if the cleaned name drifts between runs,
 * learned rules stop matching and the user's corrections silently stop working.
 * Prefer under-cleaning to aggressive cleaning.
 */

import { US_CITIES } from './us-cities.js';

/**
 * Processor prefixes that wrap the real merchant name.
 * A non-null value means the prefix identifies the merchant itself, so the
 * remainder (usually an order reference) is discarded rather than parsed —
 * "AMZN Mktp US*RT4G59DK3" is Amazon, not a merchant called "RT4G59DK3".
 */
const PROCESSOR_PREFIXES = [
  ['amzn mktp us', 'Amazon'],
  ['amzn mktp ca', 'Amazon'],
  ['amzn mktp', 'Amazon'],
  ['amazon.com', 'Amazon'],
  ['amzn digital', 'Amazon Digital'],
  ['sq *', null], ['sq*', null],
  ['tst*', null], ['tst *', null],
  ['paypal *', null], ['pp*', null], ['pp *', null],
  ['venmo *', null],
  ['sp *', null], ['sp*', null],
  ['wl *', null],
  ['clv*', null], ['clover *', null],
  ['zel ', null], ['zelle ', null],
  ['intuit *', null],
  ['godaddy *', null],
];

/**
 * Transaction-type noise banks prepend. Longer entries first, so
 * "purchase authorized on" is consumed before a bare "purchase".
 */
const TYPE_PREFIXES = [
  'purchase authorized on',
  'recurring payment authorized on',
  'pos purchase', 'pos debit', 'pos credit',
  'debit card purchase', 'checkcard', 'check card',
  'ach debit', 'ach credit', 'ach pmt',
  'preauthorized debit', 'preauthorized credit',
  'direct dep', 'direct deposit',
  'electronic deposit', 'external withdrawal', 'external deposit',
  'online payment', 'bill payment', 'web pmt',
  'purchase', 'payment', 'withdrawal', 'deposit',
];

/** Store-format suffixes that add nothing to merchant identity. */
const SUFFIX_NOISE = new Set([
  'WHSE', 'WAREHOUSE', 'SUPERCENTER', 'SUPERCTR', 'STORE', 'MKT', 'MARKETPLACE',
  'GAS', 'FUEL', 'WEB', 'ONLINE', 'WWW', 'COM', 'AUTOPAY', 'AUTOPMT',
]);

const STATE_CODES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

/** Words that keep non-standard casing in the final title-cased output. */
const CASING_OVERRIDES = {
  usa: 'USA', us: 'US', llc: 'LLC', inc: 'Inc',
  atm: 'ATM', dmv: 'DMV', irs: 'IRS', usps: 'USPS', ups: 'UPS',
  'at&t': 'AT&T', 'pg&e': 'PG&E', 'h&m': 'H&M', 'h-e-b': 'H-E-B', heb: 'H-E-B',
  tv: 'TV', nyc: 'NYC', cvs: 'CVS', hbo: 'HBO', ikea: 'IKEA',
  mcdonalds: "McDonald's", walmart: 'Walmart', costco: 'Costco',
  '7-eleven': '7-Eleven', bp: 'BP', arco: 'ARCO', kfc: 'KFC',
};

/** Strip leading noise prefixes repeatedly (banks stack them). */
function stripTypePrefixes(text) {
  let out = text;
  let changed = true;
  while (changed) {
    changed = false;
    const lower = out.toLowerCase().trimStart();
    for (const prefix of TYPE_PREFIXES) {
      if (lower.startsWith(prefix)) {
        out = out.trimStart().slice(prefix.length);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * Strip processor prefixes. Returns {text, canonical} — canonical is set when
 * the prefix itself identified the merchant, in which case text is irrelevant.
 */
function stripProcessorPrefixes(text) {
  let out = text;
  let changed = true;
  while (changed) {
    changed = false;
    const lower = out.toLowerCase().trimStart();
    for (const [prefix, canonical] of PROCESSOR_PREFIXES) {
      if (lower.startsWith(prefix)) {
        if (canonical) return { text: canonical, canonical };
        out = out.trimStart().slice(prefix.length);
        changed = true;
        break;
      }
    }
  }
  return { text: out, canonical: null };
}

/** Remove a trailing "CITY ST" or "CITY" using the known-city list. */
function stripLocation(tokens) {
  let out = [...tokens];

  if (out.length > 1 && STATE_CODES.has(out[out.length - 1].toUpperCase())) {
    out.pop();
  }

  // Try the longest city match first so "SAN FRANCISCO" beats "FRANCISCO".
  for (const span of [3, 2, 1]) {
    if (out.length <= span) continue;
    const candidate = out.slice(-span).join(' ').toUpperCase();
    if (US_CITIES.has(candidate)) {
      out = out.slice(0, -span);
      break;
    }
  }
  return out;
}

/** Title case, preserving known acronyms and already-intentional mixed case. */
function titleCase(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const bare = word.toLowerCase().replace(/[^a-z0-9&'-]/g, '');
      if (CASING_OVERRIDES[bare]) return CASING_OVERRIDES[bare];
      // Leave words that already look deliberately mixed (eBay, iTunes).
      if (/[a-z]/.test(word) && /[A-Z]/.test(word.slice(1))) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Clean a raw bank description into a recognizable merchant name.
 *
 * @param {string} raw - description as it arrives from the bank
 * @param {string} [merchantName] - Plaid's own merchant_name when present.
 *   Plaid resolves this server-side and it is far cleaner than the raw string,
 *   so we trust it and only fall back to parsing. This is the common path.
 * @returns {string} cleaned payee, or 'Unknown' if nothing survives
 */
export function cleanPayee(raw, merchantName = null) {
  if (merchantName && merchantName.trim()) return merchantName.trim();
  if (!raw || !raw.trim()) return 'Unknown';

  let text = raw.trim();

  // Type noise first — the string is "POS DEBIT SQ *MERCHANT", so the outer
  // layer has to come off before the processor prefix is visible.
  text = stripTypePrefixes(text);
  const { text: afterProc, canonical } = stripProcessorPrefixes(text);
  if (canonical) return canonical;
  text = afterProc;

  // Leading date left by "PURCHASE AUTHORIZED ON 07/14".
  text = text.replace(/^\s*\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\s*/, '');

  // Trailing reference/auth codes: runs mixing letters and digits, or long
  // digit runs. Also matches at string start (after a prefix was consumed).
  text = text.replace(/(^|\s+)[A-Z0-9]*\d[A-Z0-9]{5,}\s*$/i, '');
  text = text.replace(/\s+#?\d{5,}\s*$/, '');

  // Store numbers: "#1234", "STORE 4412", and bare trailing 2-4 digit numbers.
  text = text.replace(/\s+#\s*\d+/g, '');
  text = text.replace(/\s+store\s+\d+/gi, '');
  text = text.replace(/\s+\d{2,4}\s*$/, '');

  // Domain suffixes: "NETFLIX.COM" -> "NETFLIX".
  text = text.replace(/\.(com|net|org|co|io)\b/gi, '');

  let tokens = text.trim().split(/\s+/).filter(Boolean);
  tokens = stripLocation(tokens);

  // Trailing format noise, but never strip down to nothing.
  while (tokens.length > 1 && SUFFIX_NOISE.has(tokens[tokens.length - 1].toUpperCase())) {
    tokens.pop();
  }

  text = tokens.join(' ')
    .replace(/[*#]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[\s\-.,]+$/, '')
    .replace(/^[\s\-.,]+/, '');

  if (!text) return 'Unknown';
  return titleCase(text);
}

/**
 * Key used to group transactions from the same merchant.
 * Case- and punctuation-insensitive so "Blue Bottle" and "BLUE BOTTLE." match.
 */
export function payeeKey(payee) {
  return payee.toLowerCase().replace(/[^a-z0-9]/g, '');
}
