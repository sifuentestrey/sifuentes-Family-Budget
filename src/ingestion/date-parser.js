/**
 * Date extraction from bill text.
 *
 * Split out from the bill parser because date handling carries most of the
 * ambiguity and deserves its own tests. Two problems dominate:
 *
 *   **Ambiguous numeric dates.** "03/04/2026" is March 4th in the US and April
 *   3rd almost everywhere else. There is no way to resolve this from the string
 *   alone, so the locale is an explicit parameter rather than a guess, and any
 *   date that could go either way is reported with reduced confidence.
 *
 *   **Missing years.** Bills routinely say "Due September 15" with no year.
 *   Naively defaulting to the current year puts a January bill eleven months in
 *   the past when it is parsed in December. The year is inferred relative to the
 *   statement date when one is known, and otherwise chosen as the nearest
 *   plausible future date.
 */

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const MONTH_NAMES = Object.keys(MONTHS).join('|');

/**
 * @typedef {object} ParsedDate
 * @property {string} iso
 * @property {number} confidence
 * @property {boolean} ambiguous     - true when day/month order was a coin flip
 * @property {boolean} yearInferred
 */

/**
 * Parse a single date string.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {'US'|'ISO'|'EU'} [opts.locale='US']
 * @param {string} [opts.referenceDate] - anchor for inferring a missing year
 * @returns {ParsedDate|null}
 */
export function parseDate(text, opts = {}) {
  if (!text) return null;
  const locale = opts.locale ?? 'US';
  const reference = opts.referenceDate ? new Date(`${opts.referenceDate}T00:00:00Z`) : new Date();
  const cleaned = text.trim();

  // ISO first — unambiguous, so it gets full confidence.
  const iso = cleaned.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const built = build(+iso[1], +iso[2], +iso[3]);
    if (built) return { iso: built, confidence: 1, ambiguous: false, yearInferred: false };
  }

  // "September 15, 2026" / "Sep 15 2026"
  //
  // The day is guarded with (?!\d) so it cannot swallow the leading digits of a
  // year. Without it, "8 August 2026" matches as "August 20" — taking "20" from
  // "2026" as the day — and silently returns the 20th.
  const monthFirst = cleaned.match(
    new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`, 'i'),
  );
  if (monthFirst) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    const day = +monthFirst[2];
    const year = monthFirst[3] ? +monthFirst[3] : inferYear(month, day, reference);
    const built = build(year, month, day);
    if (built) {
      return {
        iso: built,
        confidence: monthFirst[3] ? 0.95 : 0.8,
        ambiguous: false,
        yearInferred: !monthFirst[3],
      };
    }
  }

  const dayFirst = cleaned.match(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\.?(?:,?\\s*(\\d{4}))?`, 'i'),
  );
  if (dayFirst) {
    const month = MONTHS[dayFirst[2].toLowerCase()];
    const day = +dayFirst[1];
    const year = dayFirst[3] ? +dayFirst[3] : inferYear(month, day, reference);
    const built = build(year, month, day);
    if (built) {
      return {
        iso: built,
        confidence: dayFirst[3] ? 0.95 : 0.8,
        ambiguous: false,
        yearInferred: !dayFirst[3],
      };
    }
  }

  // Numeric: 03/04/2026, 3-4-26, 03/04
  const numeric = cleaned.match(/\b(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?\b/);
  if (numeric) {
    const first = +numeric[1];
    const second = +numeric[2];
    let year = numeric[3] ? normalizeYear(+numeric[3]) : null;

    // If one value exceeds 12 it can only be the day, which resolves the order
    // regardless of locale.
    let month;
    let day;
    let ambiguous = false;

    if (first > 12 && second <= 12) {
      day = first; month = second;
    } else if (second > 12 && first <= 12) {
      month = first; day = second;
    } else {
      // Genuinely ambiguous — both plausible. Follow the locale and say so.
      ambiguous = first !== second;
      if (locale === 'US') { month = first; day = second; }
      else { day = first; month = second; }
    }

    if (year === null) year = inferYear(month, day, reference);
    const built = build(year, month, day);
    if (built) {
      let confidence = numeric[3] ? 0.85 : 0.7;
      // An unresolvable order is the single largest source of wrong due dates,
      // so it is penalised hard enough to fall below the review threshold.
      if (ambiguous) confidence -= 0.25;
      return { iso: built, confidence, ambiguous, yearInferred: !numeric[3] };
    }
  }

  return null;
}

/**
 * Find a date that follows one of the given labels.
 *
 * @param {string} text
 * @param {string[]} labels
 * @param {object} [opts] - passed through to parseDate
 * @returns {(ParsedDate & {label: string})|null}
 */
export function findLabelledDate(text, labels, opts = {}) {
  if (!text) return null;

  for (const label of labels) {
    // Allow separators and a little noise between the label and the value,
    // but stop at a newline so a label never captures a date from another row.
    const pattern = new RegExp(
      `${escapeRegex(label)}\\s*[:\\-–—]?\\s*([^\\n\\r]{0,40})`,
      'i',
    );
    const match = text.match(pattern);
    if (!match) continue;

    const parsed = parseDate(match[1], opts);
    if (parsed) return { ...parsed, label };
  }
  return null;
}

/**
 * Choose the year for a date that did not include one.
 *
 * Bills reference dates close to their statement, so the correct year is
 * whichever puts the date nearest the reference — which may be the next year
 * for a December statement naming a January due date, or the previous year for
 * a January statement naming a December service period.
 */
function inferYear(month, day, reference) {
  const refYear = reference.getUTCFullYear();
  const candidates = [refYear - 1, refYear, refYear + 1];

  let best = refYear;
  let bestDistance = Infinity;
  for (const year of candidates) {
    const time = Date.UTC(year, month - 1, day);
    const distance = Math.abs(time - reference.getTime());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = year;
    }
  }
  return best;
}

function normalizeYear(year) {
  if (year >= 1000) return year;
  // Two-digit years: bills are never from the 1900s in this context.
  return 2000 + year;
}

function build(year, month, day) {
  if (!year || !month || !day) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects things like Feb 30, which Date silently rolls over.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;

  return date.toISOString().slice(0, 10);
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
