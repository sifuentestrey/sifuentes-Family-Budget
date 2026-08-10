/**
 * Expected vs actual paycheck reconciliation.
 *
 * When a real paystub arrives, compare it to what was forecast and record the
 * difference. Two purposes:
 *
 *   **Catch errors.** A forecast that misses actual net by 15% usually means a
 *   wrong pay rate, a missed deduction, or unreported hours — a payroll problem
 *   worth noticing, not a modelling curiosity.
 *
 *   **Improve the estimate.** Tax assumptions start as guesses. Effective rates
 *   derived from real stubs converge on the truth within a few pay periods, which
 *   matters more than any modelling sophistication: the biggest source of error
 *   in a take-home estimate is almost always the tax rate, not the hours.
 *
 * Discrepancies are stored rather than applied automatically. A single unusual
 * check — a bonus, a retro adjustment, a one-off garnishment — should not
 * permanently reshape the model.
 */

/** Net difference beyond this fraction is worth flagging to a human. */
const MATERIAL_VARIANCE = 0.05;

/** Reconciled stubs needed before derived rates are trustworthy. */
const MIN_SAMPLES_FOR_LEARNING = 3;

/**
 * Net error beyond this is a structural mismatch, not a rate to tune.
 * Learning from it would bake the mistake into every future forecast.
 */
const IMPLAUSIBLE_ERROR_PERCENT = 50;

const round = (n) => Math.round(n * 100) / 100;

/**
 * @typedef {object} LineComparison
 * @property {string} label
 * @property {number} expected
 * @property {number} actual
 * @property {number} difference       - actual - expected
 * @property {number|null} percentDifference
 * @property {boolean} material
 */

/**
 * @typedef {object} Reconciliation
 * @property {string} paystubId
 * @property {string} payDate
 * @property {LineComparison} gross
 * @property {LineComparison} net
 * @property {LineComparison} taxes
 * @property {LineComparison} deductions
 * @property {LineComparison[]} deductionDetail
 * @property {boolean} materialVariance
 * @property {string[]} findings
 * @property {object} derivedRates
 */

/**
 * Compare a forecast against the paystub that actually arrived.
 *
 * @param {import('./forecast.js').PaycheckForecast} forecast
 * @param {import('../domain/payroll.js').Paystub} paystub
 * @returns {Reconciliation}
 */
export function reconcilePaycheck(forecast, paystub) {
  const expected = forecast.breakdown;
  const findings = [];

  const gross = compare('Gross', expected.totalGross, paystub.grossPay);
  const net = compare('Net', expected.estimatedNet, paystub.netPay);
  const taxes = compare('Taxes', expected.totalTaxes, paystub.totalTaxes);

  const actualDeductionTotal = (paystub.deductions ?? []).reduce((s, d) => s + d.amount, 0);
  const deductions = compare('Deductions', expected.totalDeductions, actualDeductionTotal);

  const deductionDetail = compareDeductions(expected.deductions, paystub.deductions ?? []);

  // Gross matching while net misses means the error is in taxes or deductions,
  // not in the hours — a much more useful diagnosis than "the forecast was off".
  if (!gross.material && net.material) {
    findings.push(
      'Hours and gross pay were forecast correctly; the miss is in taxes or deductions. ' +
      'The tax assumptions in the pay profile are the thing to adjust.',
    );
  }
  if (gross.material) {
    const direction = gross.difference > 0 ? 'more' : 'less';
    findings.push(
      `Actual gross was ${formatMoney(Math.abs(gross.difference))} ${direction} than forecast. ` +
      'Usually unreported hours, a rate change, or overtime not captured on the timecard.',
    );
  }
  for (const line of deductionDetail) {
    if (line.expected === 0 && line.actual > 0) {
      findings.push(`"${line.label}" (${formatMoney(line.actual)}) is not in the pay profile.`);
    } else if (line.actual === 0 && line.expected > 0) {
      findings.push(`"${line.label}" was expected but did not appear on this stub.`);
    }
  }

  return {
    paystubId: paystub.id,
    payDate: paystub.payDate,
    gross,
    net,
    taxes,
    deductions,
    deductionDetail,
    materialVariance: gross.material || net.material,
    findings,
    derivedRates: deriveRates(paystub),
  };
}

function compare(label, expectedValue, actualValue) {
  const expected = round(expectedValue ?? 0);
  const actual = round(actualValue ?? 0);
  const difference = round(actual - expected);
  const percentDifference = expected !== 0 ? round((difference / expected) * 100) : null;

  return {
    label,
    expected,
    actual,
    difference,
    percentDifference,
    material: expected !== 0
      ? Math.abs(difference / expected) > MATERIAL_VARIANCE
      : actual !== 0,
  };
}

/** Match deduction lines by normalized label so minor wording differences align. */
function compareDeductions(expectedList, actualList) {
  const normalize = (label) => label.toLowerCase().replace(/[^a-z0-9]/g, '');
  const byLabel = new Map();

  for (const d of expectedList ?? []) {
    byLabel.set(normalize(d.label), { label: d.label, expected: d.amount, actual: 0 });
  }
  for (const d of actualList ?? []) {
    const key = normalize(d.label);
    const existing = byLabel.get(key);
    if (existing) existing.actual = d.amount;
    else byLabel.set(key, { label: d.label, expected: 0, actual: d.amount });
  }

  return [...byLabel.values()].map((entry) => compare(entry.label, entry.expected, entry.actual));
}

/**
 * Effective rates implied by one actual stub.
 * These are observations, not settings — `learnFromHistory` decides whether
 * enough of them agree to be worth adopting.
 */
function deriveRates(paystub) {
  const gross = paystub.grossPay || 0;
  if (gross <= 0) return { effectiveTaxRate: null, effectiveNetRate: null };

  return {
    effectiveTaxRate: round((paystub.totalTaxes / gross) * 1000) / 1000,
    effectiveNetRate: round((paystub.netPay / gross) * 1000) / 1000,
    grossToNetRatio: round((paystub.netPay / gross) * 1000) / 1000,
  };
}

/**
 * Summarize a run of reconciliations into learned adjustments.
 *
 * Uses the median, not the mean: one bonus period or retro payment would drag a
 * mean far enough to make every subsequent forecast wrong in the opposite
 * direction.
 *
 * @param {Reconciliation[]} history
 * @returns {LearnedAdjustments}
 */
export function learnFromHistory(history) {
  const usable = (history ?? []).filter((r) => r.gross.actual > 0);

  if (usable.length < MIN_SAMPLES_FOR_LEARNING) {
    return {
      sampleSize: usable.length,
      ready: false,
      reason: `${usable.length} of ${MIN_SAMPLES_FOR_LEARNING} paychecks needed before adjusting the model`,
      meanNetErrorPercent: usable.length
        ? median(usable.map((r) => r.net.percentDifference ?? 0))
        : 0,
    };
  }

  const netErrors = usable.map((r) => r.net.percentDifference ?? 0);
  const medianError = median(netErrors);

  // An error this large is not a mis-tuned tax rate. It means the forecast was
  // built from the wrong period, the wrong profile, or an empty timecard —
  // and "learning" from it would bake that mistake into every future estimate.
  // Refuse to suggest adjustments and say what is actually wrong.
  if (Math.abs(medianError) > IMPLAUSIBLE_ERROR_PERCENT) {
    return {
      sampleSize: usable.length,
      ready: false,
      meanNetErrorPercent: medianError,
      reason:
        `Forecasts differ from actual pay by ${Math.abs(medianError).toFixed(0)}%, which is too ` +
        'large to be a tax or deduction problem. Check that forecasts are being matched to the ' +
        'right pay period and that the timecard covers it.',
    };
  }

  const taxRates = usable
    .map((r) => r.derivedRates.effectiveTaxRate)
    .filter((rate) => rate != null);

  const suggestedTaxRate = taxRates.length ? median(taxRates) : null;
  const medianNetError = medianError;

  // Deductions appearing on most stubs but missing from the profile are almost
  // certainly real and recurring.
  const missing = new Map();
  for (const rec of usable) {
    for (const line of rec.deductionDetail) {
      if (line.expected === 0 && line.actual > 0) {
        if (!missing.has(line.label)) missing.set(line.label, []);
        missing.get(line.label).push(line.actual);
      }
    }
  }

  const suggestedDeductions = [...missing.entries()]
    .filter(([, amounts]) => amounts.length >= Math.ceil(usable.length / 2))
    .map(([label, amounts]) => ({
      label,
      amount: round(median(amounts)),
      seenOn: amounts.length,
      of: usable.length,
    }));

  return {
    sampleSize: usable.length,
    ready: true,
    meanNetErrorPercent: medianNetError,
    consistentlyOver: medianNetError < -MATERIAL_VARIANCE * 100,
    consistentlyUnder: medianNetError > MATERIAL_VARIANCE * 100,
    suggestedTaxRate,
    suggestedDeductions,
    summary: buildSummary(medianNetError, suggestedTaxRate, suggestedDeductions, usable.length),
  };
}

function buildSummary(medianNetError, suggestedTaxRate, suggestedDeductions, sampleSize) {
  const parts = [];

  if (Math.abs(medianNetError) < MATERIAL_VARIANCE * 100) {
    parts.push(`Forecasts have tracked actual net within ${Math.abs(medianNetError).toFixed(1)}% across ${sampleSize} paychecks.`);
  } else if (medianNetError < 0) {
    parts.push(`Forecasts have run ${Math.abs(medianNetError).toFixed(1)}% high across ${sampleSize} paychecks — take-home is consistently less than predicted.`);
  } else {
    parts.push(`Forecasts have run ${medianNetError.toFixed(1)}% low across ${sampleSize} paychecks.`);
  }

  if (suggestedTaxRate != null) {
    parts.push(`Observed effective tax rate is ${(suggestedTaxRate * 100).toFixed(1)}%.`);
  }
  if (suggestedDeductions.length) {
    parts.push(
      `${suggestedDeductions.length} recurring deduction(s) appear on stubs but not in the pay profile: ` +
      suggestedDeductions.map((d) => `${d.label} (${formatMoney(d.amount)})`).join(', ') + '.',
    );
  }
  return parts.join(' ');
}

/**
 * Apply learned adjustments to a pay profile.
 *
 * Returns a NEW profile. Never mutates, and never runs automatically — the
 * caller decides whether to adopt, because silently rewriting someone's pay
 * configuration from inferred numbers is exactly the kind of invisible change
 * that becomes impossible to debug later.
 *
 * @param {import('../domain/payroll.js').PayProfile} profile
 * @param {LearnedAdjustments} learned
 */
export function applyLearnedAdjustments(profile, learned) {
  if (!learned?.ready) {
    return { profile, changed: false, changes: [], reason: learned?.reason ?? 'not enough history' };
  }

  const changes = [];
  const next = { ...profile, taxAssumptions: { ...profile.taxAssumptions } };

  if (learned.suggestedTaxRate != null) {
    const current = profile.taxAssumptions.federalRate
      + profile.taxAssumptions.stateRate
      + profile.taxAssumptions.socialSecurityRate
      + profile.taxAssumptions.medicareRate;

    if (Math.abs(current - learned.suggestedTaxRate) > 0.01) {
      // FICA rates are statutory and known exactly, so the observed total is
      // reconciled by adjusting only the withholding portion, which is the part
      // that genuinely varies by household.
      const statutory = profile.taxAssumptions.socialSecurityRate + profile.taxAssumptions.medicareRate;
      const withholding = Math.max(0, learned.suggestedTaxRate - statutory);
      const federalShare = current > statutory
        ? profile.taxAssumptions.federalRate / (current - statutory)
        : 0.7;

      next.taxAssumptions.federalRate = round(withholding * federalShare * 1000) / 1000;
      next.taxAssumptions.stateRate = round(withholding * (1 - federalShare) * 1000) / 1000;
      changes.push(
        `tax withholding ${(current * 100).toFixed(1)}% -> ${(learned.suggestedTaxRate * 100).toFixed(1)}% (from actual stubs)`,
      );
    }
  }

  if (learned.suggestedDeductions?.length) {
    next.recurringDeductions = [
      ...profile.recurringDeductions,
      ...learned.suggestedDeductions.map((d) => ({ label: d.label, amount: d.amount, preTax: false })),
    ];
    for (const d of learned.suggestedDeductions) {
      changes.push(`added recurring deduction "${d.label}" ${formatMoney(d.amount)} (seen on ${d.seenOn}/${d.of} stubs)`);
    }
  }

  return { profile: next, changed: changes.length > 0, changes };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatMoney(n) {
  return `$${Math.abs(n).toFixed(2)}`;
}

/**
 * @typedef {object} LearnedAdjustments
 * @property {number} sampleSize
 * @property {boolean} ready
 * @property {string} [reason]
 * @property {number} meanNetErrorPercent
 * @property {boolean} [consistentlyOver]
 * @property {boolean} [consistentlyUnder]
 * @property {number|null} [suggestedTaxRate]
 * @property {{label: string, amount: number, seenOn: number, of: number}[]} [suggestedDeductions]
 * @property {string} [summary]
 */
