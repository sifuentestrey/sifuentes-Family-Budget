/**
 * Safe-to-spend.
 *
 * The number the household actually opens the app for. Deliberately not
 * balance-minus-bills, which is wrong in both directions and dangerous in one:
 *
 *   - It ignores pending transactions, so money already spent is counted as
 *     available.
 *   - It ignores everything past the next bill — groceries, fuel, and the
 *     ordinary variable spending that continues regardless.
 *   - It treats savings goals and the emergency buffer as spendable.
 *   - With variable income it silently assumes the next check will be average,
 *     which for this household is wrong roughly half the time.
 *
 * The calculation is a series of named deductions from the current balance, each
 * of which the UI can show. A single opaque figure people do not trust gets
 * ignored; a figure with its arithmetic visible gets used.
 *
 * Horizon is "until the next payday" rather than a calendar month, because that
 * is the interval the household must actually survive on the money in hand.
 */

const DAY_MS = 86400000;
const round = (n) => Math.round(n * 100) / 100;

/**
 * @typedef {object} SafeToSpendInput
 * @property {number} currentBalance              - spendable cash across checking
 * @property {number} [pendingOutflows]           - authorized, not yet posted
 * @property {string} [asOf]
 * @property {string} nextPayday
 * @property {number} [expectedIncomeBeforePayday] - income landing before then
 * @property {object[]} [bills]                    - domain Bill objects
 * @property {number} [dailyVariableSpend]         - groceries/fuel per day
 * @property {number} [bufferTarget]               - emergency floor, never spendable
 * @property {number} [bufferBalance]              - how much of it exists
 * @property {{label: string, monthlyContribution: number}[]} [savingsGoals]
 * @property {number} [sinkingFundContribution]    - monthly, for irregular bills
 * @property {'floor'|'expected'} [incomeBasis='floor']
 */

/**
 * @typedef {object} SafeToSpendResult
 * @property {number} safeToSpend
 * @property {number} perDay
 * @property {number} daysUntilPayday
 * @property {{label: string, amount: number, note: string}[]} deductions
 * @property {number} startingPoint
 * @property {'comfortable'|'tight'|'negative'} status
 * @property {string} headline
 * @property {string[]} warnings
 * @property {object} inputs
 */

/**
 * @param {SafeToSpendInput} input
 * @returns {SafeToSpendResult}
 */
export function calculateSafeToSpend(input) {
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
  const warnings = [];

  const daysUntilPayday = Math.max(0, Math.round(
    (Date.parse(`${input.nextPayday}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / DAY_MS,
  ));

  const deductions = [];
  const incomeBasis = input.incomeBasis ?? 'floor';

  // Start from cash actually on hand, plus income that lands before payday.
  const expectedIncome = input.expectedIncomeBeforePayday ?? 0;
  const startingPoint = input.currentBalance + expectedIncome;

  // 1. Pending transactions. Already spent; the bank just hasn't posted them.
  //    Omitting these is the single most common way a "safe to spend" figure
  //    overstates by exactly the amount most recently spent.
  const pending = input.pendingOutflows ?? 0;
  if (pending > 0) {
    deductions.push({
      label: 'Pending transactions',
      amount: round(pending),
      note: 'already spent, not yet posted by the bank',
    });
  }

  // 2. Unpaid bills falling due before the next payday.
  const bills = (input.bills ?? []).filter(
    (b) => b.status !== 'paid' && b.status !== 'ignored'
      && b.dueDate >= asOf && b.dueDate < input.nextPayday,
  );
  const billTotal = bills.reduce((sum, b) => sum + b.amountDue, 0);
  if (billTotal > 0) {
    deductions.push({
      label: `Bills due before ${input.nextPayday}`,
      amount: round(billTotal),
      note: `${bills.length} bill(s): ${bills.map((b) => b.providerName).join(', ')}`,
    });
  }

  // Low-confidence bills are counted but flagged — excluding them would make
  // the household feel richer than they are, which is the more harmful error.
  const unconfirmed = bills.filter((b) => b.confidence < 0.7 && b.source !== 'manual');
  if (unconfirmed.length) {
    warnings.push(
      `${unconfirmed.length} bill(s) were parsed with low confidence and are included at their ` +
      `detected amounts: ${unconfirmed.map((b) => b.providerName).join(', ')}`,
    );
  }

  // 3. Ordinary variable spending that continues regardless of bills.
  const variable = (input.dailyVariableSpend ?? 0) * daysUntilPayday;
  if (variable > 0) {
    deductions.push({
      label: 'Groceries, fuel and similar',
      amount: round(variable),
      note: `${daysUntilPayday} days at ${formatMoney(input.dailyVariableSpend)}/day, from your own history`,
    });
  }

  // 4. Sinking-fund contribution, prorated. Irregular annual bills are what
  //    break a budget in month four; setting the money aside now is what stops
  //    it, and it is not available to spend.
  if (input.sinkingFundContribution > 0) {
    const prorated = (input.sinkingFundContribution * 12 / 365) * daysUntilPayday;
    deductions.push({
      label: 'Set aside for annual bills',
      amount: round(prorated),
      note: 'insurance premiums, registration and similar, spread across the year',
    });
  }

  // 5. Savings goals, prorated.
  for (const goal of input.savingsGoals ?? []) {
    const prorated = (goal.monthlyContribution * 12 / 365) * daysUntilPayday;
    if (prorated > 0) {
      deductions.push({
        label: goal.label,
        amount: round(prorated),
        note: 'savings goal contribution for this stretch',
      });
    }
  }

  // 6. The emergency buffer is a floor, not a deduction — it is money that must
  //    remain, so only the shortfall against it reduces what is spendable.
  const bufferTarget = input.bufferTarget ?? 0;
  const bufferBalance = input.bufferBalance ?? 0;
  const bufferShortfall = Math.max(0, bufferTarget - bufferBalance);
  if (bufferShortfall > 0) {
    deductions.push({
      label: 'Emergency buffer floor',
      amount: round(bufferShortfall),
      note: bufferBalance > 0
        ? `${formatMoney(bufferBalance)} of a ${formatMoney(bufferTarget)} target is held elsewhere`
        : 'kept back so a slow stretch does not become credit card debt',
    });
  }

  const totalDeductions = deductions.reduce((sum, d) => sum + d.amount, 0);
  const safeToSpend = round(startingPoint - totalDeductions);
  const perDay = daysUntilPayday > 0 ? round(safeToSpend / daysUntilPayday) : safeToSpend;

  if (incomeBasis === 'floor' && expectedIncome > 0) {
    warnings.push(
      'Income before payday is counted at your conservative floor, not an average. ' +
      'A better-than-usual check makes this number rise, never fall.',
    );
  }
  if (expectedIncome > 0 && input.currentBalance < billTotal) {
    warnings.push(
      'This depends on expected income arriving before the bills are due. ' +
      'Current balance alone does not cover them.',
    );
  }

  const status = safeToSpend < 0 ? 'negative' : safeToSpend < (input.dailyVariableSpend ?? 0) * 3 ? 'tight' : 'comfortable';

  return {
    safeToSpend,
    perDay,
    daysUntilPayday,
    deductions,
    startingPoint: round(startingPoint),
    status,
    headline: buildHeadline(status, safeToSpend, perDay, daysUntilPayday, input.nextPayday),
    warnings,
    inputs: {
      currentBalance: round(input.currentBalance),
      expectedIncome: round(expectedIncome),
      incomeBasis,
      billsCounted: bills.length,
      totalDeductions: round(totalDeductions),
    },
  };
}

function buildHeadline(status, safeToSpend, perDay, days, payday) {
  if (status === 'negative') {
    return `Committed spending exceeds available money by ${formatMoney(Math.abs(safeToSpend))} before ${payday}. ` +
      `Something has to move — a bill's due date, or discretionary spending.`;
  }
  if (status === 'tight') {
    return `${formatMoney(safeToSpend)} free until ${payday} — about ${formatMoney(perDay)} a day across ${days} days. Tight.`;
  }
  return `${formatMoney(safeToSpend)} free until ${payday}, roughly ${formatMoney(perDay)} a day across ${days} days.`;
}

/**
 * Monthly rollup for the dashboard.
 *
 * Answers the "AUGUST — expected income / bills / already paid / upcoming"
 * summary, separately from the tighter until-payday number.
 *
 * @param {object} input
 * @param {string} input.month              - "YYYY-MM"
 * @param {number} input.expectedIncome
 * @param {object[]} input.bills
 * @param {string} [input.nextPayday]
 * @param {string} [input.asOf]
 */
export function monthlyOverview(input) {
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
  const inMonth = (input.bills ?? []).filter((b) => b.dueDate.startsWith(input.month));

  const paid = inMonth.filter((b) => b.status === 'paid');
  const upcoming = inMonth.filter((b) => b.status !== 'paid' && b.status !== 'ignored');

  const paidTotal = paid.reduce((s, b) => s + (b.paidAmount ?? b.amountDue), 0);
  const upcomingTotal = upcoming.reduce((s, b) => s + b.amountDue, 0);

  const beforePayday = input.nextPayday
    ? upcoming.filter((b) => b.dueDate >= asOf && b.dueDate < input.nextPayday)
    : [];

  return {
    month: input.month,
    expectedIncome: round(input.expectedIncome ?? 0),
    billsTotal: round(paidTotal + upcomingTotal),
    alreadyPaid: round(paidTotal),
    upcoming: round(upcomingTotal),
    dueBeforeNextPaycheck: round(beforePayday.reduce((s, b) => s + b.amountDue, 0)),
    dueBeforeNextPaycheckCount: beforePayday.length,
    billCount: inMonth.length,
    remaining: round((input.expectedIncome ?? 0) - paidTotal - upcomingTotal),
  };
}

function formatMoney(n) {
  return `$${Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
