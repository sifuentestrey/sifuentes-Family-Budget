/**
 * Fuzzy provider-name matching.
 *
 * The same company reaches this app under different spellings depending on
 * the channel: a Gmail parse might produce the provider key "netflixcom", a
 * hand-typed entry "netflix", a bank feed's payee "NETFLIX.COM 12345 CA".
 * Byte-exact comparison treats these as unrelated providers, which is
 * exactly how one real bill ends up counted twice — entered once by hand and
 * once by the automated parser, each blind to the other.
 */
import { slugify } from './bill.js';

/** Lowercase, alphanumeric-only — good enough to compare across channels. */
export function normalizeProviderName(name) {
  return slugify(name || '').replace(/-/g, '');
}

/**
 * True if two provider names likely name the same company.
 *
 * Exact match after normalization, or one is a substring of the other
 * (catches "netflix" inside "netflixcom" or "netflix inc"). Guarded by a
 * minimum length so short names ("gas", "aa") don't collide on a coincidence.
 */
export function providersMatch(a, b) {
  const na = normalizeProviderName(a);
  const nb = normalizeProviderName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  return shorter.length >= 4 && longer.includes(shorter);
}
