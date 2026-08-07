// GENERATED FILE — do not edit.
// Source of truth: src/engine/guidance.js
// Regenerate with: npm run sync:shared
/**
 * Guidance engine.
 *
 * Applies the standard personal-finance order of operations to this
 * household's actual numbers and returns ranked next actions, each with a
 * dollar amount and its reasoning.
 *
 * Every recommendation states *why*, because guidance that can't be argued
 * with can't be trusted. The user should be able to read a step, disagree, and
 * skip it — the ordering is a well-established default, not a moral claim.
 *
 * Deliberately excluded: specific investments, tax positions, insurance
 * amounts. Those depend on tax bracket, state, employer benefits, and health,
 * none of which appear in a transaction feed. The engine says so and points at
 * a flat-fee fee-only planner rather than guessing.
 */

/** APR above which debt outranks saving. */
const HIGH_INTEREST_APR = 7;

/** Emergency fund target, in months of survival cost. */
const EMERGENCY_MONTHS_MIN = 4;
const EMERGENCY_MONTHS_MAX = 6;

function round(n) {
  return Number(n.toFixed(2));
}

function money(n) {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/**
 * Buffer target for variable income.
 *
 * Sized to the household's own observed income variability rather than a
 * generic rule: the gap between what a slow stretch pays and what the month
 * costs, held for three months. A household whose income barely moves needs
 * little; one swinging by half needs a lot. Floored at one month of committed
 * costs so a currently-comfortable household still holds something.
 */
export function bufferTarget({ survivalMonthlyCost, reliableMonthlyIncome, committedMonthly }) {
  const monthlyGap = Math.max(0, survivalMonthlyCost - reliableMonthlyIncome);
  return round(Math.max(monthlyGap * 3, committedMonthly));
}

/**
 * Debt payoff comparison.
 *
 * Presents avalanche and snowball side by side with real payoff dates and the
 * actual dollar difference, rather than asserting one is correct. Avalanche
 * wins on arithmetic; snowball wins on the probability of sticking with it.
 * With the numbers visible the household can weigh that trade themselves.
 */
export function compareDebtStrategies(debts, monthlyExtra) {
  if (!debts.length) return null;

  const simulate = (order) => {
    const remaining = order.map((d) => ({ ...d }));
    let month = 0;
    let interestPaid = 0;

    while (remaining.some((d) => d.balance > 0.01) && month < 600) {
      month++;
      let extra = monthlyExtra;

      for (const debt of remaining) {
        if (debt.balance <= 0.01) continue;
        const monthlyRate = debt.apr / 100 / 12;
        const interest = debt.balance * monthlyRate;
        interestPaid += interest;
        debt.balance += interest;

        const payment = Math.min(debt.balance, debt.minimumPayment);
        debt.balance -= payment;
      }

      // Everything spare goes at the first unpaid debt in priority order.
      for (const debt of remaining) {
        if (extra <= 0) break;
        if (debt.balance <= 0.01) continue;
        const applied = Math.min(extra, debt.balance);
        debt.balance -= applied;
        extra -= applied;
      }
    }

    return { months: month, interestPaid: round(interestPaid) };
  };

  const avalanche = simulate([...debts].sort((a, b) => b.apr - a.apr));
  const snowball = simulate([...debts].sort((a, b) => a.balance - b.balance));

  return {
    avalanche: { ...avalanche, order: [...debts].sort((a, b) => b.apr - a.apr).map((d) => d.name) },
    snowball: { ...snowball, order: [...debts].sort((a, b) => a.balance - b.balance).map((d) => d.name) },
    interestDifference: round(snowball.interestPaid - avalanche.interestPaid),
    monthsDifference: snowball.months - avalanche.months,
    note:
      'Avalanche (highest rate first) never costs more in interest, and usually costs ' +
      'less. Snowball (smallest balance first) clears individual debts sooner, which is ' +
      'why people stick with it more often. When your smallest balance is also your ' +
      'highest rate the two are the same plan and the difference is zero. Otherwise the ' +
      'figure below is what the motivation costs.',
  };
}

/**
 * Build the ranked action list.
 *
 * @param {object} state
 * @param {object} state.picture - from buildExpensePicture
 * @param {object} state.coverage - from floorCoverage
 * @param {number} state.monthlySurplus - reliable income minus true cost
 * @param {object} state.balances - { buffer, emergency }
 * @param {Array<object>} state.debts - [{ name, balance, apr, minimumPayment }]
 * @param {object} state.flags - { hasFullEmployerMatch, childPlannedWithinYears }
 */
export function buildGuidance(state) {
  const { picture, coverage, monthlySurplus, balances = {}, debts = [], flags = {} } = state;
  const steps = [];

  // Step 0 — a structural deficit outranks everything. No savings plan means
  // anything while the floor cannot cover necessities.
  if (coverage.status === 'deficit') {
    steps.push({
      priority: 1,
      key: 'close_deficit',
      title: 'Close the gap between floor income and necessities',
      amount: round(Math.abs(coverage.survivalSurplus)),
      why:
        `On a slow stretch, income runs ${money(Math.abs(coverage.survivalSurplus))} short of ` +
        `necessities alone. Until that closes, any savings target would just be ` +
        `borrowed back later. The levers are committed costs (the largest are ` +
        `${picture.categories.filter((c) => c.bucket === 'committed').slice(0, 2).map((c) => c.category).join(' and ')}) ` +
        `or raising the income floor.`,
      blocking: true,
    });
  }

  // Step 1 — employer match. Asserted rather than recommended when already
  // captured; repeating advice someone has already acted on trains them to
  // skim past the list.
  if (flags.hasFullEmployerMatch) {
    steps.push({
      priority: steps.length + 1,
      key: 'employer_match',
      title: 'Employer match — already captured',
      amount: 0,
      why:
        'The full match is being claimed. Nothing else available returns 50–100% ' +
        'immediately, so this correctly sits ahead of everything below and needs no action.',
      status: 'done',
    });
  } else {
    steps.push({
      priority: steps.length + 1,
      key: 'employer_match',
      title: 'Capture the full employer match',
      amount: null,
      why:
        'An unclaimed match is a 50–100% instant return. That beats paying off even ' +
        'high-interest cards, which is why it comes before debt rather than after.',
      blocking: false,
    });
  }

  // Step 2 — starter buffer.
  const targetBuffer = bufferTarget({
    survivalMonthlyCost: picture.survivalMonthlyCost,
    reliableMonthlyIncome: coverage.reliableMonthlyIncome,
    committedMonthly: picture.monthly.committed,
  });
  const bufferGap = Math.max(0, targetBuffer - (balances.buffer ?? 0));

  if (bufferGap > 0) {
    steps.push({
      priority: steps.length + 1,
      key: 'starter_buffer',
      title: 'Build the income buffer',
      amount: round(bufferGap),
      target: targetBuffer,
      monthsToGoal: monthlySurplus > 0 ? Math.ceil(bufferGap / monthlySurplus) : null,
      why:
        `With variable income the buffer is what converts an unpredictable paycheck into ` +
        `a predictable budget. Sized here to ${money(targetBuffer)} from this household's own ` +
        `income swing, not a generic rule. Until it exists, a slow stretch has nowhere to ` +
        `go except a credit card.`,
    });
  }

  // Step 3 — sinking funds.
  if (picture.irregularAnnualTotal > 0) {
    steps.push({
      priority: steps.length + 1,
      key: 'sinking_funds',
      title: 'Fund the irregular bills',
      amount: round(picture.irregularAnnualTotal / 12),
      annual: picture.irregularAnnualTotal,
      why:
        `${money(picture.irregularAnnualTotal)} a year arrives in lumps rather than monthly — ` +
        `insurance premiums, registration, and the like. Setting aside ` +
        `${money(picture.irregularAnnualTotal / 12)} monthly means they are already paid for when ` +
        `they land. This is the least interesting item on the list and the one that most ` +
        `often prevents new card debt.`,
    });
  }

  // Step 4 — high-interest debt.
  const highInterest = debts.filter((d) => d.apr >= HIGH_INTEREST_APR && d.balance > 0);
  if (highInterest.length) {
    const total = highInterest.reduce((s, d) => s + d.balance, 0);
    const worstApr = Math.max(...highInterest.map((d) => d.apr));
    steps.push({
      priority: steps.length + 1,
      key: 'high_interest_debt',
      title: 'Clear high-interest debt',
      amount: round(total),
      why:
        `${money(total)} at up to ${worstApr}% APR. Paying it down returns exactly that rate, ` +
        `guaranteed and tax-free — better than any investment offers reliably. ` +
        `Above roughly ${HIGH_INTEREST_APR}% this outranks further saving.`,
      comparison: compareDebtStrategies(highInterest, Math.max(monthlySurplus, 0)),
    });
  }

  // Step 5 — full emergency fund, sized on survival cost.
  const emergencyTarget = picture.survivalMonthlyCost * EMERGENCY_MONTHS_MIN;
  const emergencyGap = Math.max(0, emergencyTarget - (balances.emergency ?? 0));
  if (emergencyGap > 0) {
    steps.push({
      priority: steps.length + 1,
      key: 'emergency_fund',
      title: `Emergency fund — ${EMERGENCY_MONTHS_MIN}–${EMERGENCY_MONTHS_MAX} months`,
      amount: round(emergencyGap),
      target: round(emergencyTarget),
      monthsToGoal: monthlySurplus > 0 ? Math.ceil(emergencyGap / monthlySurplus) : null,
      why:
        `Sized on ${money(picture.survivalMonthlyCost)} a month of necessities, not the ` +
        `${money(picture.trueMonthlyCost)} the household normally spends. Dining out and ` +
        `shopping stop in a real emergency, so including them inflates the target and ` +
        `makes it feel unreachable. The smaller number is the correct one.`,
    });
  }

  // Step 6 — child transition.
  if (flags.childPlannedWithinYears != null) {
    steps.push({
      priority: steps.length + 1,
      key: 'child_transition',
      title: `Prepare for a child (~${flags.childPlannedWithinYears} years out)`,
      amount: null,
      why:
        'Two things are time-sensitive. Parental leave removes the stable income that ' +
        'currently anchors the fixed bills — the specific risk for a household with one ' +
        'variable earner. And childcare will absorb most of the surplus currently ' +
        'available for debt payoff, so clearing cards before it starts is materially ' +
        'easier than after.',
      seeAlso: 'child-transition',
    });
  }

  return {
    steps,
    disclaimer:
      'This is budgeting arithmetic on your own numbers, not licensed financial advice. ' +
      'For investment selection, tax strategy, or insurance amounts, a flat-fee ' +
      '(not percentage-of-assets) fee-only CFP is worth the cost — those depend on ' +
      'details a transaction feed cannot see.',
  };
}

/**
 * The structural recommendation specific to a mixed-stability household.
 *
 * Pooling both incomes and budgeting the average makes every fixed bill depend
 * partly on the unpredictable one. Anchoring commitments to the stable income
 * instead means a slow run of shifts threatens only discretionary spending —
 * the same money, arranged so the variance lands where it does no damage.
 */
export function incomeStructureAdvice(modeledStreams, picture) {
  const stable = modeledStreams.filter((s) => s.distribution.stability === 'stable');
  const variable = modeledStreams.filter((s) => s.distribution.stability !== 'stable');
  if (!stable.length || !variable.length) return null;

  const stableMonthly = stable.reduce((sum, s) => {
    const rate = s.cadence === 'semimonthly' ? 2 : s.cadence === 'biweekly' ? 26 / 12 : 1;
    return sum + s.distribution.median * rate;
  }, 0);

  const covers = stableMonthly >= picture.monthly.committed;

  return {
    stableEarner: stable[0].payee,
    variableEarner: variable[0].payee,
    stableMonthly: round(stableMonthly),
    committedMonthly: picture.monthly.committed,
    stableCoversCommitted: covers,
    recommendation: covers
      ? `Run the fixed bills off ${stable[0].payee} (${money(stableMonthly)}/mo, which covers ` +
        `${money(picture.monthly.committed)} of commitments) and treat the variable income as ` +
        `the savings engine. A slow run of shifts then threatens nothing that matters.`
      : `The stable income (${money(stableMonthly)}/mo) does not quite cover committed costs ` +
        `(${money(picture.monthly.committed)}/mo), so ${money(picture.monthly.committed - stableMonthly)} ` +
        `of fixed bills still depends on variable pay. Closing that gap — or reducing ` +
        `commitments to fit — removes most of the risk in this household's finances.`,
  };
}
