/**
 * Deterministic household money-planning snapshot.
 *
 * This engine intentionally separates present facts from forecasts. It does
 * not move money, make payments, or infer missing amounts as facts.
 */

import { projectNext } from './cadence.js';
import { splitParentIds, isSplitParent } from './split.js';

const DAY = 86_400_000;
const PAYCHECK_HORIZON_DAYS = 70;
const round = (value) => Math.round(Number(value || 0) * 100) / 100;
const iso = (date) => new Date(`${date}T00:00:00Z`);
const addDays = (date, days) => new Date(iso(date).getTime() + days * DAY).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.max(0, Math.round((iso(to).getTime() - iso(from).getTime()) / DAY));

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function monthDays(date) {
  const [year, month] = String(date).slice(0, 7).split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function sum(values) {
  return round(values.reduce((total, value) => total + Number(value || 0), 0));
}

function accountBalance(account) {
  const available = account.available_balance ?? account.availableBalance;
  const current = account.current_balance ?? account.currentBalance ?? account.balance;
  return {
    available: available != null && Number.isFinite(Number(available)) ? Number(available) : null,
    current: Number.isFinite(Number(current)) ? Number(current) : 0,
  };
}

function accountType(account) {
  const type = String(account.type || '').toLowerCase();
  const subtype = String(account.subtype || '').toLowerCase();
  // Plaid often reports checking as { type: 'depository', subtype: 'checking' }.
  return subtype === 'checking' || subtype === 'savings' ? subtype : type;
}

function billDueDate(bill) {
  return bill.dueDate || bill.due_date || null;
}

function billAmount(bill) {
  return Number(bill.amountDue ?? bill.amount_due ?? bill.amount ?? 0);
}

function billIsPaid(bill) {
  if (typeof bill?.paid === 'boolean') return bill.paid;
  return String(bill?.status || '').toLowerCase() === 'paid' || bill?.paid === true;
}

function billIsOpen(bill) {
  return !['cancelled', 'dismissed', 'ignored'].includes(String(bill.status || '').toLowerCase())
    && !billIsPaid(bill);
}

function billSource(bill) {
  if (bill.verifiedAmount || (['manual', 'email', 'pdf'].includes(bill.source) && !bill.needsReview) || bill.amount_source === 'verified' || bill.source === 'verified') return 'verified amount';
  return 'recurring estimate';
}

function confidenceForBill(bill) {
  return billSource(bill) === 'verified amount' ? 'high' : 'medium';
}

function paycheckDate(paycheck) {
  return paycheck.date || paycheck.pay_date || paycheck.expected_date || null;
}

function paycheckAmount(paycheck) {
  return Number(paycheck.expected_amount ?? paycheck.net_amount ?? paycheck.amount ?? 0);
}

function paycheckStatus(paycheck) {
  if (paycheck.is_final || paycheck.status === 'final' || paycheck.status === 'verified') return 'verified';
  if (paycheck.incomplete_timecard || paycheck.status === 'incomplete') return 'incomplete';
  return 'forecast';
}

function paycheckBasis(paycheck) {
  if (paycheckStatus(paycheck) === 'verified') return 'verified paystub or payroll record';
  if (paycheckStatus(paycheck) === 'incomplete') return 'incomplete timecard — amount not final';
  return paycheck.basis || 'pay schedule and available payroll history';
}

function forecastPaychecks({ paychecks = [], incomeStreams = [], asOf, horizonDays = PAYCHECK_HORIZON_DAYS }) {
  const cutoff = addDays(asOf, horizonDays);
  const entries = [];
  for (const stream of incomeStreams) {
    let date = stream.next_expected;
    // Stale streams must not invent deposits which never arrived.
    if (!validDate(date) || date < asOf) continue;
    for (let i = 0; date && date <= cutoff && i < 40; i++) {
      entries.push({ date, amount: round(stream.typical_amount), status: 'forecast',
        basis: 'income stream history', confidence: 'low',
        streamId: stream.id || `${stream.account_id}:${stream.payee}`, payee: stream.payee });
      const next = projectNext(date, stream.cadence);
      if (!next || next <= date) break;
      date = next;
    }
  }
  for (const paycheck of paychecks) {
    const date = paycheckDate(paycheck);
    if (!validDate(date) || date < asOf || date > cutoff) continue;
    const match = entries.findIndex(e => Math.abs(Date.parse(e.date) - Date.parse(date)) <= 3 * DAY && paycheck.streamId && e.streamId === paycheck.streamId);
    const entry = { date, amount: round(paycheckAmount(paycheck)), status: paycheckStatus(paycheck),
      basis: paycheckBasis(paycheck), confidence: paycheck.confidence || (paycheckStatus(paycheck) === 'verified' ? 'high' : 'low'),
      streamId: paycheck.streamId, payee: paycheck.payee };
    if (match >= 0) entries[match] = entry;
    else entries.push(entry);
  }
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.date) || { date: entry.date, amount: 0, status: 'verified', confidence: 'high', sources: [] };
    group.amount = round(group.amount + entry.amount);
    group.sources.push(entry);
    if (entry.status === 'incomplete') group.status = 'incomplete';
    else if (entry.status !== 'verified' && group.status !== 'incomplete') group.status = 'forecast';
    if (entry.confidence === 'low') group.confidence = 'low';
    else if (entry.confidence !== 'high' && group.confidence === 'high') group.confidence = 'medium';
    group.basis = [...new Set(group.sources.map(e => e.basis))].join(' + ');
    groups.set(entry.date, group);
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function categorySpend(transactions, category, start, end) {
  const parents = splitParentIds(transactions);
  const postedPendingIds = new Set(transactions.filter(t => !t.pending).map(t => t.pending_transaction_id).filter(Boolean));
  return sum(transactions.filter(t => {
    const date = t.posted_date || t.date;
    return date >= start && date < end && t.category === category
      && !t.is_transfer && !t.is_income && !isSplitParent(t, parents)
      && !(t.pending && postedPendingIds.has(t.plaid_transaction_id || t.id));
  }).map(t => t.amount));
}

function allowanceForWindow({ category, monthlyTarget, transactions, asOf, nextPayday, periodStart, provisional }) {
  let cursor = periodStart;
  let allowance = 0;
  while (cursor < nextPayday) {
    allowance += Number(monthlyTarget || 0) / monthDays(cursor);
    cursor = addDays(cursor, 1);
  }
  const spent = categorySpend(transactions, category, periodStart, addDays(asOf, 1));
  return { category, planned: round(allowance), target: round(allowance), spent,
    left: round(Math.max(0, allowance - spent)), overBy: round(Math.max(0, spent - allowance)),
    periodStart, periodEnd: nextPayday, provisional, daysRemaining: daysBetween(asOf, nextPayday),
    label: provisional ? 'Estimate — paycheck period not confirmed' :
      spent > allowance ? `Over plan by $${round(spent - allowance).toFixed(2)}` :
      `$${round(Math.max(0, allowance - spent)).toFixed(2)} left until payday` };
}

function assignBills({ bills, paychecks, asOf, includePaid = false }) {
  const candidateBills = bills.filter((bill) => {
    const status = String(bill.status || '').toLowerCase();
    if (!validDate(billDueDate(bill))) return false;
    if (['cancelled', 'dismissed', 'ignored'].includes(status)) return false;
    return includePaid || !billIsPaid(bill);
  });
  const dueBeforeNext = [];
  const groups = new Map(paychecks.map((paycheck) => [paycheck.date, []]));
  const later = [];

  for (const bill of candidateBills) {
    const dueDate = billDueDate(bill);
    const eligible = paychecks.filter((paycheck) => paycheck.date <= dueDate);
    const latest = eligible.at(-1);
    const item = {
      ...bill,
      dueDate,
      amountDue: round(billAmount(bill)),
      amountSource: billSource(bill),
      confidence: confidenceForBill(bill),
      paid: billIsPaid(bill),
      expected: !billIsPaid(bill),
    };

    if (dueDate > addDays(asOf, PAYCHECK_HORIZON_DAYS)) later.push(item);
    else if (dueDate < (paychecks[0]?.date || '9999-12-31')) dueBeforeNext.push(item);
    else if (latest) groups.get(latest.date).push(item);
    else later.push(item);
  }

  return {
    dueBeforeNext: dueBeforeNext.sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    groups: paychecks.map((paycheck) => ({
      paycheckDate: paycheck.date,
      bills: groups.get(paycheck.date),
      total: sum(groups.get(paycheck.date)
        .filter((bill) => !billIsPaid(bill))
        .map((bill) => bill.amountDue)),
      grossTotal: sum(groups.get(paycheck.date).map((bill) => bill.amountDue)),
    })),
    later: later.sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
  };
}

/**
 * @param {object} input
 * @param {string} input.asOf YYYY-MM-DD in household time
 * @param {object[]} input.accounts Current connected account records
 * @param {object[]} input.bills Exact and recurring bill records
 * @param {object[]} input.paychecks Payroll/paystub/timecard forecasts
 * @param {object[]} input.incomeStreams Fallback income streams when payroll is unavailable
 * @param {Record<string, number>} input.budgetTargets User-approved monthly flexible-category targets
 * @param {string[]} input.flexibleCategories Categories to show as pay-period allowance bars
 * @param {object[]} input.transactions Posted categorized transactions
 */
export function buildHouseholdPlan({
  asOf,
  accounts = [],
  bills = [],
  paychecks = [],
  incomeStreams = [],
  budgetTargets = {},
  flexibleCategories = ['Groceries', 'Dining Out', 'Gas', 'Household/Fun'],
  transactions = [],
  includePaidBills = false,
  budgetPeriodStart = null,
} = {}) {
  if (!validDate(asOf)) throw new Error('asOf must be YYYY-MM-DD');

  const checkingAccounts = accounts.filter((account) => accountType(account) === 'checking');
  const savingsAccounts = accounts.filter((account) => accountType(account) === 'savings');
  const checkingAvailable = sum(checkingAccounts.map((account) => accountBalance(account).available ?? accountBalance(account).current));
  const checkingCurrent = sum(checkingAccounts.map((account) => accountBalance(account).current));
  const savingsAvailable = sum(savingsAccounts.map((account) => accountBalance(account).available ?? accountBalance(account).current));

  const forecasts = forecastPaychecks({ paychecks, incomeStreams, asOf });
  const nextPaycheck = forecasts[0] || null;
  const followingPaycheck = forecasts[1] || null;
  const assignments = assignBills({
    bills, paychecks: forecasts, asOf, includePaid: includePaidBills,
  });
  const beforeNext = assignments.dueBeforeNext;
  const beforeNextTotal = sum(beforeNext
    .filter((bill) => !billIsPaid(bill))
    .map((bill) => bill.amountDue));
  const assigned = nextPaycheck
    ? assignments.groups.find((group) => group.paycheckDate === nextPaycheck.date) || { bills: [], total: 0 }
    : { bills: [], total: 0 };

  const allowanceEnd = forecasts.find(p => p.date > asOf)?.date || addDays(asOf.slice(0, 7) + '-01', monthDays(asOf));
  const observedPaydays = transactions.filter(t => t.is_income && !t.is_transfer && !t.pending && Number(t.amount) <= -100)
    .map(t => t.posted_date || t.date).filter(d => validDate(d) && d <= asOf).sort();
  const knownStart = budgetPeriodStart || observedPaydays.at(-1);
  const periodStart = validDate(knownStart) && knownStart <= asOf && daysBetween(knownStart, asOf) <= 40
    ? knownStart : asOf.slice(0, 7) + '-01';
  const provisionalWindow = periodStart !== knownStart || !nextPaycheck;
  const allowances = flexibleCategories
    .filter((category) => Number(budgetTargets[category]) > 0)
    .map((category) => allowanceForWindow({
      category,
      monthlyTarget: budgetTargets[category],
      transactions,
      asOf,
      nextPayday: allowanceEnd,
      periodStart, provisional: provisionalWindow,
    }));

  const projectedCheckingAtPayday = round(checkingAvailable - beforeNextTotal);
  const expectedAfterAssignedBills = nextPaycheck && nextPaycheck.status !== 'incomplete'
    ? round(projectedCheckingAtPayday + nextPaycheck.amount - assigned.total)
    : null;
  const gap = Math.max(0, -projectedCheckingAtPayday);
  const attention = [];

  if (beforeNextTotal > checkingAvailable) {
    attention.push({
      type: 'coverage_gap_before_payday',
      priority: 'high',
      label: `$${gap.toFixed(2)} needed before the next paycheck`,
      reason: `$${beforeNextTotal.toFixed(2)} in bills are due before ${nextPaycheck?.date || 'a known paycheck'}, while checking has $${checkingAvailable.toFixed(2)} available.`,
      confidence: 'high',
    });
  }
  const flexibleRemaining = sum(allowances.map(a => a.left));
  // Carry checking forward exactly once. These are forecasts, not reservations
  // or approval to spend. Savings and incomplete payroll cannot close a gap.
  let projectedBalance = round(checkingAvailable - beforeNextTotal
    - (nextPaycheck?.date > asOf ? flexibleRemaining : 0));
  const fundingTimeline = assignments.groups.map((group, index) => {
    const paycheck = forecasts[index];
    const end = forecasts[index + 1]?.date || addDays(asOf, PAYCHECK_HORIZON_DAYS);
    let everydayBudget = 0;
    if (paycheck.date === asOf) everydayBudget = flexibleRemaining;
    else for (let date = paycheck.date; date < end; date = addDays(date, 1)) {
      everydayBudget += flexibleCategories.reduce((total, category) => total + Math.max(0, Number(budgetTargets[category]) || 0), 0) / monthDays(date);
    }
    everydayBudget = round(everydayBudget);
    const usableIncome = paycheck.status === 'incomplete' ? null : paycheck.amount;
    const carryInNeeded = usableIncome === null ? null : round(Math.max(0, group.total + everydayBudget - usableIncome));
    projectedBalance = usableIncome === null || projectedBalance === null ? null
      : round(projectedBalance + usableIncome - group.total - everydayBudget);
    return { paycheckDate: paycheck.date, through: end, bills: group.total, everydayBudget,
      expectedIncome: usableIncome, carryInNeeded, projectedBalance, reserved: false,
      basis: 'Checking plus forecast pay, less known bills and category budgets; not money set aside' };
  });
  const reviewedBills = bills.filter(b => b.needsReview && billIsOpen(b));
  if (reviewedBills.length) attention.push({ type: 'bill_payment_review', priority: 'high',
    label: `${reviewedBills.length} bill payment${reviewedBills.length === 1 ? '' : 's'} need${reviewedBills.length === 1 ? 's' : ''} review`,
    reason: 'Uncertain payments are not marked paid. Their full bill amounts remain in the plan until matched.', confidence: 'high' });
  const futureGap = fundingTimeline.find(row => row.projectedBalance !== null && row.projectedBalance < 0);
  if (futureGap) attention.push({ type: 'future_funding_gap', priority: 'high', label: 'A future paycheck period needs more money',
    reason: `The plan starting ${futureGap.paycheckDate} is short by $${round(-futureGap.projectedBalance).toFixed(2)} through ${futureGap.through}, using current checking, forecast pay, known bills, and category budgets. No money has been reserved.`, confidence: 'medium' });
  const carryForward = fundingTimeline.find(row => row.carryInNeeded > 0);
  if (!futureGap && carryForward) attention.push({ type: 'carry_forward_needed', priority: 'medium', label: 'Keep earlier money for a bill-heavy paycheck',
    reason: `The ${carryForward.paycheckDate} paycheck period needs $${carryForward.carryInNeeded.toFixed(2)} carried forward from earlier checking funds for known bills and category budgets. This is a planning estimate, not money already set aside.`, confidence: 'medium' });
  if (checkingAvailable >= beforeNextTotal && checkingAvailable < beforeNextTotal + flexibleRemaining) {
    attention.push({ type: 'budget_cash_gap', priority: 'high', label: 'Everyday budgets need adjusting',
      reason: `Bills and remaining category budgets exceed checking by $${round(beforeNextTotal + flexibleRemaining - checkingAvailable).toFixed(2)} before payday. Category limits do not guarantee that cash is available.`, confidence: 'medium' });
  }
  if (nextPaycheck?.status === 'incomplete') {
    attention.push({
      type: 'incomplete_paycheck',
      priority: 'medium',
      label: 'Next paycheck is not final yet',
      reason: 'Its timecard is incomplete, so the app will not use the forecast to declare bills covered.',
      confidence: 'high',
    });
  }

  return {
    version: 1,
    asOf,
    facts: {
      checking: {
        available: checkingAvailable,
        current: checkingCurrent,
        accountCount: checkingAccounts.length,
        label: 'Checking now',
      },
      savings: {
        available: savingsAvailable,
        accountCount: savingsAccounts.length,
        label: 'Savings',
      },
      dueBeforeNextPayday: {
        total: beforeNextTotal,
        bills: beforeNext,
        label: nextPaycheck ? `Bills due before ${nextPaycheck.date}` : 'Bills due before next known payday',
      },
    },
    forecasts: {
      nextPaycheck: nextPaycheck && {
        ...nextPaycheck,
        label: 'Expected next paycheck',
        isFinal: nextPaycheck.status === 'verified',
      },
      followingPaycheck,
      nextPaycheckPlan: nextPaycheck && {
        bills: assigned.bills,
        billsTotal: assigned.total,
        expectedCheckingAfterAssignedBills: expectedAfterAssignedBills,
        label: 'Expected checking after this plan',
        confidence: nextPaycheck.status === 'verified' ? 'high' : 'medium',
        basedOn: [nextPaycheck.basis, ...assigned.bills.map((bill) => bill.amountSource)],
      },
      paycheckGroups: assignments.groups.map(g => ({ ...g, paycheck: forecasts.find(p => p.date === g.paycheckDate) })),
      fundingTimeline,
      laterBills: assignments.later,
    },
    budgetWindow: { start: periodStart, end: allowanceEnd, provisional: provisionalWindow },
    allowances,
    attention,
    diagnostics: {
      checkingBalanceIsAvailable: checkingAccounts.every((account) => accountBalance(account).available !== null),
      daysUntilNextPaycheck: nextPaycheck ? daysBetween(asOf, nextPaycheck.date) : null,
      projectedCheckingAtPayday,
    },
  };
}
