/**
 * Forecast fluctuating household utilities from bill history.
 *
 * estimate = median of comparable history
 * reserve = upper quartile / recent high-water mark
 * interval = observed 25th–75th percentile
 */

/**
 * @typedef {'water'|'electric'|'gas'|'internet'|'other'} UtilityType
 * @typedef {'provider_api'|'email_import'|'pdf_import'|'transaction_match'|'manual'} UtilitySource
 *
 * @typedef {object} UtilityBill
 * @property {string} provider
 * @property {UtilityType} utilityType
 * @property {string} billDate
 * @property {string} [dueDate]
 * @property {number} amount
 * @property {number} [usage]
 * @property {string} [usageUnit]
 * @property {UtilitySource} source
 * @property {string} [sourceRef]
 */

/**
 * Same-month history gets priority because Texas electricity is seasonal.
 * @param {{provider: string, utilityType: UtilityType, bills: UtilityBill[], targetMonth: number}} input
 */
export function forecastUtility(input) {
  const { provider, utilityType, bills, targetMonth } = input;
  const eligible = bills
    .filter((bill) => bill.provider === provider && bill.utilityType === utilityType)
    .filter((bill) => Number.isFinite(bill.amount) && bill.amount >= 0)
    .sort((a, b) => a.billDate.localeCompare(b.billDate));

  if (!eligible.length) {
    return {
      provider, utilityType, targetMonth,
      estimatedAmount: null, reserveAmount: null, interval: null,
      confidence: 'low', confidenceScore: 0,
      sampleSize: 0, sameMonthSampleSize: 0,
      reasons: ['no bill history yet'],
    };
  }

  const sameMonth = eligible.filter((bill) => monthOf(bill.billDate) === targetMonth);
  const sample = sameMonth.length >= 2 ? sameMonth : eligible.slice(-6);
  const amounts = sample.map((bill) => bill.amount).sort((a, b) => a - b);
  const recent = eligible.slice(-3).map((bill) => bill.amount);
  const estimatedAmount = round(median(amounts));
  const p25 = round(percentile(amounts, 0.25));
  const p75 = round(percentile(amounts, 0.75));
  const recentHigh = recent.length ? Math.max(...recent) : estimatedAmount;
  const reserveAmount = round(Math.max(p75, recentHigh));

  const sourceQuality = sample.reduce((sum, bill) => sum + sourceWeight(bill.source), 0) / sample.length;
  const seasonalBonus = sameMonth.length >= 2 ? 0.15 : 0;
  const sampleScore = Math.min(0.35, sample.length / 8 * 0.35);
  const score = clamp(0.2 + sampleScore + sourceQuality * 0.3 + seasonalBonus, 0, 1);
  const confidence = score >= 0.75 ? 'high' : score >= 0.45 ? 'medium' : 'low';

  const reasons = [];
  if (sameMonth.length >= 2) reasons.push(`${sameMonth.length} comparable bills from this month of the year`);
  else reasons.push('not enough same-season history; using the six most recent bills');
  if (sourceQuality >= 0.9) reasons.push('history is mostly imported from a source document or provider');
  else if (sourceQuality >= 0.6) reasons.push('history combines imported and matched transactions');
  else reasons.push('history includes manual estimates');
  if (recentHigh > estimatedAmount * 1.2) reasons.push('reserve includes a recent high bill');

  return {
    provider, utilityType, targetMonth,
    estimatedAmount, reserveAmount,
    interval: { low: p25, high: p75 },
    confidence, confidenceScore: round(score),
    sampleSize: sample.length, sameMonthSampleSize: sameMonth.length,
    reasons,
    usedBills: sample.map((bill) => bill.billDate),
  };
}

export function utilityPlanningAmount(forecast, mode = 'reserve') {
  if (!forecast || forecast.estimatedAmount == null) return null;
  return mode === 'estimate' ? forecast.estimatedAmount : forecast.reserveAmount;
}

function sourceWeight(source) {
  return source === 'provider_api' ? 1 : source === 'email_import' || source === 'pdf_import' ? 0.9
    : source === 'transaction_match' ? 0.65 : 0.35;
}
function monthOf(isoDate) { return Number(isoDate.slice(5, 7)); }
function median(values) {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}
function percentile(values, p) {
  if (values.length === 1) return values[0];
  const position = (values.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (position - lower);
}
function round(value) { return Math.round(value * 100) / 100; }
function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }
