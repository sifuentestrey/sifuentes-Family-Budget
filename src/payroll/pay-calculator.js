/**
 * Pay calculation engine.
 *
 * Turns time entries plus a pay profile into a gross/net breakdown. Written for
 * irregular schedules, because the household this serves works 4x10 with call,
 * standby and callback — a shape most payroll math gets wrong in specific,
 * costly ways:
 *
 *   **Daily overtime.** A fixed "over 8 hours in a day" rule turns every 10-hour
 *   shift into 2 hours of overtime. On a 4x10 that is 8 phantom OT hours a week —
 *   the forecast overstates take-home by hundreds of dollars every period, and
 *   the household budgets money that never arrives. `dailyOvertimeThreshold` is
 *   therefore configurable and defaults to disabled, with weekly overtime as the
 *   rule.
 *
 *   **Callback minimums.** Being called back at 2am to work 30 minutes normally
 *   pays a contractual minimum — often 2 or 4 hours. Paying the actual 0.5 hours
 *   understates the check. The minimum applies per callback event, so two
 *   separate callbacks in one night earn it twice.
 *
 *   **Standby.** Time on call but not working. Usually a flat rate per day or a
 *   reduced hourly rate, and it does not count toward the overtime threshold
 *   because no work was performed.
 *
 * Every figure is returned with its components so the UI can show the arithmetic
 * rather than asserting a number.
 */

/**
 * @typedef {object} PayBreakdown
 * @property {number} regularHours
 * @property {number} overtimeHours
 * @property {number} holidayHours
 * @property {number} ptoHours
 * @property {number} callbackPaidHours   - after minimums are applied
 * @property {number} callbackActualHours
 * @property {number} standbyUnits
 * @property {number} differentialHours
 * @property {number} regularGross
 * @property {number} overtimeGross
 * @property {number} standbyGross
 * @property {number} callbackGross
 * @property {number} holidayGross
 * @property {number} ptoGross
 * @property {number} differentialGross
 * @property {number} totalGross
 * @property {number} taxableGross        - gross minus pre-tax deductions
 * @property {{label: string, amount: number}[]} taxes
 * @property {number} totalTaxes
 * @property {{label: string, amount: number}[]} deductions
 * @property {number} totalDeductions
 * @property {number} estimatedNet
 * @property {string[]} notes
 */

const round = (n) => Math.round(n * 100) / 100;

/**
 * Split worked hours into regular and overtime.
 *
 * Order matters. Daily overtime is computed per day first (when enabled), and
 * only the remaining regular hours count toward the weekly threshold — otherwise
 * the same hour is paid at time-and-a-half twice.
 *
 * @param {import('../domain/payroll.js').TimeEntry[]} entries
 * @param {import('../domain/payroll.js').PayProfile} profile
 */
export function splitRegularAndOvertime(entries, profile) {
  const notes = [];
  const dailyThreshold = profile.dailyOvertimeThreshold ?? 0;
  const weeklyThreshold = profile.weeklyOvertimeThreshold ?? 40;

  // Employer-reported overtime is authoritative — if the timecard already
  // separates it, we must not re-derive it and double count.
  const reportedOvertime = entries.reduce((sum, e) => sum + e.overtimeHours, 0);
  const hasReportedOvertime = reportedOvertime > 0;

  let regular = 0;
  let overtime = reportedOvertime;

  const byWeek = new Map();

  for (const entry of entries) {
    // Holiday and PTO are paid separately and never count toward overtime —
    // hours not worked cannot trigger a worked-hours threshold.
    let dayRegular = entry.regularHours;

    if (!hasReportedOvertime && dailyThreshold > 0 && dayRegular > dailyThreshold) {
      const dayOvertime = dayRegular - dailyThreshold;
      overtime += dayOvertime;
      dayRegular = dailyThreshold;
      notes.push(`${entry.date}: ${round(dayOvertime)}h daily overtime over ${dailyThreshold}h`);
    }

    regular += dayRegular;

    const week = isoWeekKey(entry.date);
    byWeek.set(week, (byWeek.get(week) || 0) + dayRegular);
  }

  if (!hasReportedOvertime && weeklyThreshold > 0) {
    for (const [week, weekHours] of byWeek) {
      if (weekHours > weeklyThreshold) {
        const weekOvertime = weekHours - weeklyThreshold;
        overtime += weekOvertime;
        regular -= weekOvertime;
        notes.push(`week ${week}: ${round(weekOvertime)}h weekly overtime over ${weeklyThreshold}h`);
      }
    }
  }

  if (hasReportedOvertime) {
    notes.push('overtime taken from the timecard as reported, not re-derived');
  }
  if (dailyThreshold === 0) {
    notes.push('daily overtime disabled; a compressed schedule would otherwise generate phantom overtime');
  }

  return { regularHours: round(regular), overtimeHours: round(overtime), notes };
}

/**
 * Paid callback hours after applying the contractual minimum per event.
 *
 * @param {import('../domain/payroll.js').TimeEntry[]} entries
 * @param {import('../domain/payroll.js').PayProfile} profile
 */
export function calculateCallbackHours(entries, profile) {
  const minimum = profile.callbackMinimumHours ?? 0;
  const notes = [];

  let actual = 0;
  let paid = 0;

  for (const entry of entries) {
    if (entry.callbackHours <= 0 && entry.callbackEvents <= 0) continue;

    const events = Math.max(entry.callbackEvents, entry.callbackHours > 0 ? 1 : 0);
    actual += entry.callbackHours;

    if (minimum <= 0) {
      paid += entry.callbackHours;
      continue;
    }

    // Spread the day's callback hours across its events so each is measured
    // against the minimum separately. Two 30-minute callbacks on a 2-hour
    // minimum pay 4 hours, not 2.
    const perEvent = events > 0 ? entry.callbackHours / events : 0;
    const paidPerEvent = Math.max(perEvent, minimum);
    const dayPaid = paidPerEvent * events;
    paid += dayPaid;

    if (dayPaid > entry.callbackHours) {
      notes.push(
        `${entry.date}: ${events} callback(s) worked ${round(entry.callbackHours)}h, ` +
        `paid ${round(dayPaid)}h at the ${minimum}h minimum`,
      );
    }
  }

  return { callbackActualHours: round(actual), callbackPaidHours: round(paid), notes };
}

/**
 * Standby compensation.
 * Daily profiles pay per day on call; hourly profiles pay per standby hour.
 */
export function calculateStandby(entries, profile) {
  const rate = profile.standbyRate ?? 0;
  if (rate <= 0) return { standbyUnits: 0, standbyGross: 0, notes: [] };

  if (profile.standbyIsDaily) {
    const days = entries.filter((e) => e.standbyHours > 0).length;
    return {
      standbyUnits: days,
      standbyGross: round(days * rate),
      notes: days ? [`${days} standby day(s) at $${rate}/day`] : [],
    };
  }

  const hours = entries.reduce((sum, e) => sum + e.standbyHours, 0);
  return {
    standbyUnits: round(hours),
    standbyGross: round(hours * rate),
    notes: hours ? [`${round(hours)} standby hour(s) at $${rate}/hr`] : [],
  };
}

/**
 * Full pay calculation for a set of time entries.
 *
 * @param {import('../domain/payroll.js').TimeEntry[]} entries
 * @param {import('../domain/payroll.js').PayProfile} profile
 * @returns {PayBreakdown}
 */
export function calculatePay(entries, profile) {
  const notes = [];
  const rate = profile.baseHourlyRate;

  const { regularHours, overtimeHours, notes: otNotes } = splitRegularAndOvertime(entries, profile);
  notes.push(...otNotes);

  const { callbackActualHours, callbackPaidHours, notes: cbNotes } =
    calculateCallbackHours(entries, profile);
  notes.push(...cbNotes);

  const { standbyUnits, standbyGross, notes: sbNotes } = calculateStandby(entries, profile);
  notes.push(...sbNotes);

  const holidayHours = sum(entries, 'holidayHours');
  const ptoHours = sum(entries, 'ptoHours');

  // Differentials are an ADDITIONAL amount per hour on top of base pay, not a
  // replacement rate. Treating them as a substitute rate would wipe out base pay
  // for those hours.
  let differentialHours = 0;
  let differentialGross = 0;
  for (const entry of entries) {
    if (!entry.differentialCode || !entry.differentialHours) continue;
    const extra = profile.differentialRates?.[entry.differentialCode];
    if (!extra) {
      notes.push(`${entry.date}: no rate configured for differential "${entry.differentialCode}"`);
      continue;
    }
    differentialHours += entry.differentialHours;
    differentialGross += entry.differentialHours * extra;
  }

  const regularGross = regularHours * rate;
  const overtimeGross = overtimeHours * rate * profile.overtimeMultiplier;
  const callbackGross = callbackPaidHours * rate * profile.callbackMultiplier;
  const holidayGross = holidayHours * rate * profile.holidayMultiplier;
  const ptoGross = ptoHours * rate;

  const totalGross = regularGross + overtimeGross + standbyGross + callbackGross
    + holidayGross + ptoGross + differentialGross;

  // Pre-tax deductions reduce taxable income; post-tax ones do not.
  const deductions = resolveDeductions(profile.recurringDeductions ?? [], totalGross);
  const preTaxTotal = deductions
    .filter((d) => d.preTax)
    .reduce((s, d) => s + d.amount, 0);
  const taxableGross = Math.max(0, totalGross - preTaxTotal);

  const taxes = calculateTaxes(taxableGross, profile.taxAssumptions);
  const totalTaxes = taxes.reduce((s, t) => s + t.amount, 0);
  const totalDeductions = deductions.reduce((s, d) => s + d.amount, 0);

  const estimatedNet = totalGross - totalTaxes - totalDeductions;

  if (estimatedNet < 0) {
    notes.push('deductions and taxes exceed gross for this period; check the pay profile');
  }

  return {
    regularHours,
    overtimeHours,
    holidayHours: round(holidayHours),
    ptoHours: round(ptoHours),
    callbackPaidHours,
    callbackActualHours,
    standbyUnits,
    differentialHours: round(differentialHours),

    regularGross: round(regularGross),
    overtimeGross: round(overtimeGross),
    standbyGross: round(standbyGross),
    callbackGross: round(callbackGross),
    holidayGross: round(holidayGross),
    ptoGross: round(ptoGross),
    differentialGross: round(differentialGross),
    totalGross: round(totalGross),

    taxableGross: round(taxableGross),
    taxes,
    totalTaxes: round(totalTaxes),
    deductions,
    totalDeductions: round(totalDeductions),
    estimatedNet: round(estimatedNet),
    notes,
  };
}

/**
 * Resolve deductions to dollar amounts.
 * Percentage deductions (a 401k contribution, say) are computed against gross.
 */
function resolveDeductions(recurring, gross) {
  return recurring.map((d) => ({
    label: d.label,
    amount: round(d.isPercent ? gross * d.amount : d.amount),
    preTax: Boolean(d.preTax),
  }));
}

/**
 * Estimated taxes.
 *
 * Effective rates, not marginal brackets. Bracket math needs annual projected
 * income, filing status, allowances and state rules — none of which a timecard
 * provides, and guessing at them produces confident numbers that are wrong.
 * Effective rates taken from actual paystubs converge on the truth quickly and
 * are honest about being estimates. Reconciliation (see reconcile.js) tightens
 * them from real stubs over time.
 */
export function calculateTaxes(taxableGross, assumptions) {
  const t = assumptions ?? {};
  const taxes = [];

  const add = (label, rate) => {
    if (!rate) return;
    taxes.push({ label, amount: round(taxableGross * rate) });
  };

  add('Federal', t.federalRate);
  add('State', t.stateRate);
  add('Social Security', t.socialSecurityRate);
  add('Medicare', t.medicareRate);

  if (t.additionalFlat) taxes.push({ label: 'Additional', amount: round(t.additionalFlat) });

  return taxes;
}

function sum(entries, field) {
  return entries.reduce((total, entry) => total + (entry[field] ?? 0), 0);
}

/** ISO week key, so weekly overtime groups on the employer's week boundary. */
function isoWeekKey(isoDate) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
