/**
 * Child transition planning.
 *
 * The household expects a child in roughly two years. That is the largest
 * single change their finances will absorb, and two years is enough runway to
 * handle it deliberately — but only if the right thing is being prepared for.
 *
 * The intuitive worry is the monthly childcare bill. The sharper risk is the
 * leave gap. Elsewhere the guidance recommends anchoring fixed bills to the
 * stable semi-monthly income, precisely because the other income is variable.
 * Parental leave removes that anchor, temporarily, at the exact moment
 * expenses rise. For a household with one variable earner that is the specific
 * failure mode, and it is not obvious until it is pointed at.
 *
 * The second non-obvious point is timing. Childcare permanently consumes most
 * of the surplus currently available for debt payoff, so the capacity to clear
 * cards is at its peak right now and declines sharply once care begins. That
 * makes debt payoff time-sensitive in a way it otherwise would not be.
 *
 * Cost inputs that cannot be inferred from a transaction feed — leave policy,
 * state paid-leave programs, health plan deductible — are asked for, with
 * ranges shown until they are supplied. A confident total built on guessed
 * inputs would be worse than an honest range.
 */

function round(n) {
  return Number(n.toFixed(2));
}

function money(n) {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/**
 * Typical US infant full-time care, monthly. Wide because it genuinely is —
 * it varies several-fold by metro and is frequently more than rent.
 */
const CHILDCARE_RANGE = { low: 1200, typical: 1800, high: 2600 };

/** Typical employer-plan out-of-pocket for a birth, once deductible applies. */
const BIRTH_COST_RANGE = { low: 3000, typical: 5500, high: 9000 };

/**
 * Model the leave period.
 *
 * @param {object} leave
 * @param {number} leave.weeks - total leave taken
 * @param {number} [leave.paidWeeks=0] - weeks at full or partial pay
 * @param {number} [leave.payReplacementRate=0] - 0-1, e.g. 0.6 for state PFL
 * @param {number} leave.normalMonthlyIncome - the earner's usual monthly income
 * @param {boolean} [leave.isStableEarner] - whether this earner anchors the bills
 */
export function modelLeaveGap(leave) {
  const weeks = leave.weeks ?? 12;
  const paidWeeks = leave.paidWeeks ?? 0;
  const rate = leave.payReplacementRate ?? 0;
  const weeklyIncome = (leave.normalMonthlyIncome * 12) / 52;

  const paidPortion = paidWeeks * weeklyIncome * rate;
  const unpaidWeeks = Math.max(0, weeks - paidWeeks);
  const incomeDuringLeave = paidPortion;
  const incomeNormally = weeks * weeklyIncome;
  const incomeLost = incomeNormally - incomeDuringLeave;

  return {
    weeks,
    paidWeeks,
    unpaidWeeks,
    payReplacementRate: rate,
    incomeLost: round(incomeLost),
    incomeDuringLeave: round(incomeDuringLeave),
    isStableEarner: Boolean(leave.isStableEarner),
    warning: leave.isStableEarner
      ? 'This is the earner whose stable pay currently anchors the fixed bills. ' +
        'During leave that anchor is gone, so committed costs fall on variable income ' +
        'at the moment expenses rise. This is the risk worth pre-funding.'
      : null,
  };
}

/**
 * Full transition model.
 *
 * @param {object} input
 * @param {object} input.picture - from buildExpensePicture
 * @param {number} input.reliableMonthlyIncome
 * @param {number} input.monthlySurplus - current surplus on a bad month
 * @param {object} [input.leave] - see modelLeaveGap; omitted uses a range
 * @param {number} [input.childcareMonthly] - if known; otherwise range
 * @param {number} [input.birthCost] - deductible + OOP max; otherwise range
 * @param {number} [input.yearsAway=2]
 */
export function modelChildTransition(input) {
  const {
    picture,
    monthlySurplus,
    leave,
    childcareMonthly,
    birthCost,
    yearsAway = 2,
  } = input;

  const childcare = childcareMonthly ?? CHILDCARE_RANGE.typical;
  const childcareKnown = childcareMonthly != null;

  const birth = birthCost ?? BIRTH_COST_RANGE.typical;
  const birthKnown = birthCost != null;

  const leaveModel = leave ? modelLeaveGap(leave) : null;
  // Committed costs still run during leave regardless of income.
  const leaveExpenses = leaveModel
    ? (picture.survivalMonthlyCost / 4.33) * leaveModel.weeks
    : null;

  // One-time cost to be ready: the birth itself plus the income hole leave
  // leaves behind.
  const oneTimeNeed = birth + (leaveModel ? leaveModel.incomeLost : 0);

  // Ongoing: surplus after childcare becomes a permanent monthly expense.
  const surplusAfter = monthlySurplus - childcare;
  const surplusReduction = monthlySurplus > 0
    ? Math.min(100, (childcare / monthlySurplus) * 100)
    : 100;

  const monthsToPrepare = Math.round(yearsAway * 12);
  const monthlySetAside = monthsToPrepare > 0 ? oneTimeNeed / monthsToPrepare : oneTimeNeed;

  return {
    yearsAway,
    monthsToPrepare,

    childcare: {
      monthly: round(childcare),
      annual: round(childcare * 12),
      known: childcareKnown,
      range: childcareKnown ? null : CHILDCARE_RANGE,
      // The comparison that lands: for most households this exceeds rent.
      versusRent: picture.categories.find((c) => c.category === 'Rent/Mortgage')?.monthlyAverage ?? null,
    },

    birth: {
      cost: round(birth),
      known: birthKnown,
      range: birthKnown ? null : BIRTH_COST_RANGE,
      note:
        'Your health plan deductible plus out-of-pocket maximum. A known, plannable ' +
        'number rather than a surprise — worth looking up and sinking-funding.',
    },

    leave: leaveModel,
    leaveExpenses: leaveExpenses ? round(leaveExpenses) : null,

    oneTimeNeed: round(oneTimeNeed),
    monthlySetAside: round(monthlySetAside),

    surplus: {
      now: round(monthlySurplus),
      after: round(surplusAfter),
      reductionPercent: Math.round(surplusReduction),
      // The closing-window insight, quantified.
      debtCapacityLostPerMonth: round(Math.min(monthlySurplus, childcare)),
    },

    insights: buildInsights({
      monthlySurplus, surplusAfter, childcare, leaveModel, monthsToPrepare, oneTimeNeed,
    }),

    unknowns: [
      leave ? null : 'Each employer\'s parental leave policy — paid weeks and rate.',
      leave ? null : 'Whether your state has paid family leave. A handful do; most do not, ' +
        'and it is a large swing either way.',
      birthKnown ? null : 'Your health plan deductible and out-of-pocket maximum.',
      childcareKnown ? null : 'Local infant care rates — worth calling two or three places now, ' +
        'since waitlists in many areas run longer than a pregnancy.',
    ].filter(Boolean),
  };
}

function buildInsights({ monthlySurplus, surplusAfter, childcare, leaveModel, monthsToPrepare, oneTimeNeed }) {
  const insights = [];

  if (leaveModel?.isStableEarner) {
    insights.push({
      severity: 'high',
      title: 'Leave removes the income that anchors your fixed bills',
      detail:
        `The plan runs committed costs off the stable paycheck precisely because the other ` +
        `income varies. For ${leaveModel.weeks} weeks that stable income drops to ` +
        `${money(leaveModel.incomeDuringLeave)}, leaving rent and childcare dependent on ` +
        `call-shift work. Pre-funding ${money(leaveModel.incomeLost)} restores the anchor ` +
        `for that window.`,
    });
  }

  if (surplusAfter < 0) {
    insights.push({
      severity: 'high',
      title: 'Childcare exceeds current surplus',
      detail:
        `Childcare at ${money(childcare)}/mo is more than the ${money(monthlySurplus)} currently ` +
        `spare each month. Something has to change before care starts — committed costs, ` +
        `income, or care arrangement. Better to know now, with two years to act, than at ` +
        `the point of needing it.`,
    });
  } else {
    insights.push({
      severity: 'medium',
      title: 'Debt payoff capacity is at its peak right now',
      detail:
        `Childcare will absorb ${money(Math.min(monthlySurplus, childcare))} of the ` +
        `${money(monthlySurplus)} monthly surplus, leaving ${money(surplusAfter)}. Whatever ` +
        `high-interest debt is cleared before care starts is cleared several times faster ` +
        `than it would be after. This window closes.`,
    });
  }

  insights.push({
    severity: 'low',
    title: 'The one-time costs are plannable',
    detail:
      `${money(oneTimeNeed)} covers the birth and the leave income gap. Spread across ` +
      `${monthsToPrepare} months that is ${money(oneTimeNeed / monthsToPrepare)}/mo — ` +
      `a sinking fund, not an emergency.`,
  });

  return insights;
}
