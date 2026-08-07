/**
 * Cadence inference and date projection.
 *
 * Extracted so both `income.js` and `recurring.js` can use it without importing
 * each other. Paychecks and subscriptions share this logic entirely — the only
 * thing that differs between them is which direction of money is being grouped.
 *
 * Deliberately amount-agnostic: it looks only at dates. Call-shift work changes
 * what you are paid, never when, so amount variance must not leak into cadence
 * detection or a variable earner would be misclassified as irregular and drop
 * out of every projection.
 */

/** Expected gap in days, and how much a real schedule can wobble. */
const CADENCE_PROFILES = [
  { cadence: 'weekly', days: 7, tolerance: 2 },
  { cadence: 'biweekly', days: 14, tolerance: 3 },
  { cadence: 'semimonthly', days: 15.2, tolerance: 3 },
  { cadence: 'monthly', days: 30.4, tolerance: 4 },
];

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function daysBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 86400000;
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

/**
 * Infer cadence from the gaps between occurrences.
 *
 * Uses the median gap, not the mean: a single missed or advanced occurrence (a
 * holiday shifting payday) would drag a mean far enough to misclassify the
 * whole stream.
 *
 * Biweekly vs semi-monthly is the hard case and the one that matters most —
 * they differ by two paychecks a year, and confusing them silently corrupts
 * every month's income projection. Their median gaps are nearly identical
 * (14 vs ~15.2), so the gap alone cannot separate them.
 *
 * The reliable signal is day-of-month. Semi-monthly pay lands on the same two
 * dates every month (typically the 1st and 15th), so the distinct day-of-month
 * count stays at 2 no matter how long the history. Biweekly pay walks the
 * calendar — 26 deposits a year hit ~26 different dates. Gap variance is kept
 * as a secondary check for schedules that wobble around weekends and holidays.
 */
export function inferCadence(dates) {
  if (dates.length < 2) return 'irregular';
  const sorted = [...dates].sort();
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(daysBetween(sorted[i - 1], sorted[i]));
  }

  const med = median(gaps);

  if (med >= 12 && med <= 18) {
    const distinctDays = new Set(sorted.map((d) => new Date(d).getUTCDate()));

    // Two fixed dates every month: unambiguously semi-monthly.
    if (distinctDays.size <= 2) return 'semimonthly';

    // Weekend/holiday shifts blur the dates. Fall back to gap variance:
    // biweekly gaps are rigidly 14, semi-monthly alternates 13-17.
    const spread = median(gaps.map((g) => Math.abs(g - med)));
    if (spread > 0.9) return 'semimonthly';

    return 'biweekly';
  }

  for (const profile of CADENCE_PROFILES) {
    if (Math.abs(med - profile.days) <= profile.tolerance) return profile.cadence;
  }
  return 'irregular';
}

/**
 * Project the next expected occurrence.
 * Semi-monthly is projected to the next 1st or 15th rather than by adding days,
 * since those dates are fixed regardless of the previous gap.
 */
export function projectNext(lastDate, cadence) {
  switch (cadence) {
    case 'weekly': return addDays(lastDate, 7);
    case 'biweekly': return addDays(lastDate, 14);
    case 'monthly': return addDays(lastDate, 30);
    case 'semimonthly': {
      const d = new Date(lastDate);
      const day = d.getUTCDate();
      if (day < 15) {
        d.setUTCDate(15);
      } else {
        d.setUTCMonth(d.getUTCMonth() + 1);
        d.setUTCDate(1);
      }
      return d.toISOString().slice(0, 10);
    }
    default: return null;
  }
}
