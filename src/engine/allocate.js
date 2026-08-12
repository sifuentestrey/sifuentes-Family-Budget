/**
 * Per-paycheck allocation — "how much should I put away from this check?"
 *
 * This is the direct answer to the household's actual question, and it is
 * deliberately computed per paycheck rather than per month. With call-shift
 * income the monthly view is an abstraction that never matches any real
 * moment: a monthly surplus figure is cold comfort when a specific check is
 * light and rent is due Friday.
 *
 * The method is straightforward once the expense picture exists. From a check
 * of amount A landing on date D, with the next expected payday N:
 *
 *   1. bills falling due in [D, N)
 *   2. this check's share of irregular annual costs
 *   3. necessary variable spending for the days until N
 *   4. whatever remains is genuinely free
 *
 * Two rules keep it honest. A negative result is reported as a shortfall with
 * the amount named, never softened into a smaller positive number. And drawing
 * on the buffer during a slow stretch is reported as the buffer working, not
 * as a failure — that is what it was accumulated for, and a tool that frames it
 * as backsliding teaches people to avoid the correct behavior.
 */

/** Days between two ISO dates. */
function daysBetween(a, b) {
  return Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function round(n) {
  return Number(n.toFixed(2));
}

/**
 * Paychecks per year, used to spread annual costs across checks.
 * Biweekly is 26 — the number that makes the third-paycheck month fall out
 * naturally instead of needing a special case.
 */
function paychecksPerYear(cadence) {
  switch (cadence) {
    case 'weekly': return 52;
    case 'biweekly': return 26;
    case 'semimonthly': return 24;
    case 'monthly': return 12;
    default: return 26;
  }
}

/**
 * Bills due between two dates.
 *
 * Committed expenses are modeled by their due day rather than spread evenly,
 * because timing is the whole point: rent due on the 14th is not "half a rent"
 * against a check landing on the 10th.
 */
function billsDueBetween(commitments, fromDate, toDate) {
  const due = [];
  const start = new Date(fromDate);
  const end = new Date(toDate);

  for (const bill of commitments) {
    // Walk each candidate month in the window; a long gap can span two.
    for (let m = -1; m <= 1; m++) {
      const candidate = new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, bill.dueDay),
      );
      if (candidate >= start && candidate < end) {
        due.push({ ...bill, dueDate: candidate.toISOString().slice(0, 10) });
      }
    }
  }
  return due.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

/**
 * Allocate a single paycheck.
 *
 * @param {object} paycheck - { amount, date, cadence }
 * @param {object} ctx
 * @param {string} ctx.nextPayday - ISO date of the next expected check
 * @param {Array<object>} ctx.commitments - [{ category, amount, dueDay }]
 * @param {number} ctx.irregularAnnualTotal - annual sum of irregular costs
 * @param {number} ctx.necessaryMonthly - monthly necessary variable spending
 * @param {number} [ctx.shareOfHousehold=1] - this earner's share of the bills.
 *   With two incomes, one check should not be asked to cover 100% of rent.
 * @param {number} [ctx.bufferBalance=0]
 * @returns {object} allocation
 */
export function allocatePaycheck(paycheck, ctx) {
  const { amount, date, cadence = 'biweekly' } = paycheck;
  const nextPayday = ctx.nextPayday;
  const share = ctx.shareOfHousehold ?? 1;
  const days = daysBetween(date, nextPayday) || 14;

  // 1. This check's share of monthly committed costs, prorated by the days it
  //    covers — NOT the bills that happen to fall in this window.
  //
  //    Funding bills by due date produces wildly lumpy advice: the check
  //    landing just before rent absorbs everything and the next one absorbs
  //    nothing, so the "put away" figure swings on calendar accident rather
  //    than on what was earned. On real data that inverts the guidance
  //    entirely — the smallest check of the month can report the largest
  //    surplus, which is exactly backwards and would train someone to
  //    overspend on light checks.
  //
  //    Levelling is the point of budgeting variable income: every check sets
  //    aside its proportional share into a bills bucket, and bills are paid
  //    from that bucket when they land. Surplus then tracks the thing it
  //    should — how big the check actually was.
  const monthlyCommitted = (ctx.commitments ?? []).reduce((s, c) => s + c.amount, 0);
  const billsTotal = ((monthlyCommitted * 12) / 365) * days * share;

  // Still surfaced, so the household knows what is actually landing before the
  // next check even though funding is levelled.
  const bills = billsDueBetween(ctx.commitments ?? [], date, nextPayday);

  // 2. This check's slice of the annual irregular total. Paying it forward is
  //    what stops the yearly insurance premium from becoming card debt.
  const sinking = ((ctx.irregularAnnualTotal ?? 0) / paychecksPerYear(cadence)) * share;

  // 3. Groceries, gas and the like, prorated by days rather than by month —
  //    the window between checks is rarely a tidy half-month.
  const dailyNecessary = ((ctx.necessaryMonthly ?? 0) * 12) / 365;
  const necessary = dailyNecessary * days * share;

  const committed = billsTotal + sinking + necessary;
  const surplus = amount - committed;

  const result = {
    paycheckAmount: round(amount),
    paycheckDate: date,
    nextPayday,
    daysCovered: Math.round(days),
    // Informational: what actually lands before the next check.
    billsDueThisPeriod: bills.map((b) => ({ ...b, amount: round(b.amount * share) })),
    holdForBills: round(billsTotal),
    moveToSinking: round(sinking),
    keepForNecessary: round(necessary),
    totalCommitted: round(committed),
    surplus: round(surplus),
    shortfall: 0,
    bufferDraw: 0,
    status: 'surplus',
  };

  if (surplus < 0) {
    const shortfall = Math.abs(surplus);
    const available = ctx.bufferBalance ?? 0;

    result.status = available >= shortfall ? 'buffer_covers' : 'shortfall';
    result.shortfall = round(shortfall);
    result.bufferDraw = round(Math.min(shortfall, available));
    result.surplus = 0;
  }

  result.message = buildMessage(result);
  return result;
}

/** Plain-language instruction. The output a person actually acts on. */
function buildMessage(a) {
  const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (a.status === 'surplus') {
    return (
      `This check is ${money(a.paycheckAmount)}. Leave ${money(a.holdForBills)} in the account ` +
      `for bills due before ${a.nextPayday}. Move ${money(a.moveToSinking)} to savings for the ` +
      `once-a-year bills. Keep ${money(a.keepForNecessary)} for groceries and gas. ` +
      `The last ${money(a.surplus)} is yours to save.`
    );
  }

  if (a.status === 'buffer_covers') {
    return (
      `This check is ${money(a.paycheckAmount)} — ${money(a.shortfall)} less than you owe ` +
      `before ${a.nextPayday}. Take ${money(a.bufferDraw)} from your cushion savings. ` +
      `That's exactly what it's for; a slow stretch covered by the cushion is the plan ` +
      `working, not a setback.`
    );
  }

  return (
    `This check is ${money(a.paycheckAmount)} and falls ${money(a.shortfall)} short of what ` +
    `you owe before ${a.nextPayday}. Your cushion savings cover ${money(a.bufferDraw)} of it, ` +
    `leaving ${money(a.shortfall - a.bufferDraw)} to find. Two things can move: ask a company ` +
    `to shift a due date, or cut back on the optional spending until the next check.`
  );
}

/**
 * Allocate a run of paychecks.
 *
 * Carries the buffer balance forward so a light check draws on what earlier
 * checks contributed — modeling the buffer as it actually behaves rather than
 * evaluating each check in isolation.
 *
 * @param {Array<object>} paychecks - chronological, each { amount, date, cadence }
 * @param {object} ctx - as allocatePaycheck, plus openingBuffer
 */
export function allocateSeries(paychecks, ctx) {
  let buffer = ctx.openingBuffer ?? 0;
  const results = [];

  for (let i = 0; i < paychecks.length; i++) {
    const next = paychecks[i + 1];
    const allocation = allocatePaycheck(paychecks[i], {
      ...ctx,
      bufferBalance: buffer,
      nextPayday: next ? next.date : ctx.nextPayday,
    });

    buffer = buffer + allocation.surplus - allocation.bufferDraw;
    results.push({ ...allocation, bufferAfter: round(buffer) });
  }

  const totalSaved = results.reduce((s, r) => s + r.surplus, 0);
  const totalDrawn = results.reduce((s, r) => s + r.bufferDraw, 0);

  return {
    allocations: results,
    totalSaved: round(totalSaved),
    totalDrawn: round(totalDrawn),
    netSaved: round(totalSaved - totalDrawn),
    endingBuffer: round(buffer),
    // How often a check couldn't cover its own commitments. The honest measure
    // of whether the floor is set correctly — frequent draws mean the floor is
    // too high, not that the household is failing.
    checksNeedingBuffer: results.filter((r) => r.bufferDraw > 0).length,
  };
}

/**
 * Flag months containing an extra paycheck.
 *
 * Monthly bills are covered by the first two checks of a biweekly month, so a
 * third arrives almost entirely free. It happens twice a year and is worth
 * knowing about in advance — money that is planned for gets saved, money that
 * merely appears gets spent.
 */
export function findExtraPaycheckMonths(paydays) {
  const byMonth = new Map();
  for (const date of paydays) {
    const month = date.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) || 0) + 1);
  }

  // The usual count is the MODE, not the minimum.
  //
  // The first and last months in any history are partial — the window starts
  // and ends mid-month — so they show fewer checks than a real month has. Using
  // the minimum takes that partial count as the baseline and flags every normal
  // month as having an extra paycheck, which is both wrong and useless: the
  // whole point is to single out the two months a year that genuinely differ.
  const counts = [...byMonth.values()];
  if (!counts.length) return [];

  const frequency = new Map();
  for (const count of counts) frequency.set(count, (frequency.get(count) || 0) + 1);
  // Ties break toward the LOWER count: a month with an extra paycheck is rare
  // by definition, so when two counts appear equally often the smaller one is
  // the normal month and the larger is the exception worth flagging.
  const usual = [...frequency.entries()].sort(
    (a, b) => b[1] - a[1] || a[0] - b[0],
  )[0][0];

  return [...byMonth.entries()]
    .filter(([, count]) => count > usual)
    .map(([month, count]) => ({ month, paychecks: count, extraChecks: count - usual }));
}
