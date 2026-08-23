/**
 * Deterministic household money-planning snapshot.
 *
 * This engine intentionally separates present facts from forecasts. It does
 * not move money, make payments, or infer missing amounts as facts.
 */

const DAY = 86_400_000;
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
    available: Number.isFinite(Number(available)) ? Number(available) : null,
    current: Number.isFinite(Number(current)) ? Number(current) : 0,
  };
}

function accountType(account) {
  return String(account.type || account.subtype || '').toLowerCase();
}

function billDueDate(bill) {
  return bill.dueDate || bill.due_date || null;
}

function billAmount(bill) {
  return Number(bill.amountDue ?? bill.amount_due ?? bill.amount ?? 0);
}

function billIsOpen(bill) {
  return !['paid', 'cancelled', 'dismissed'].includes(String(bill.status || '').toLowerCase()) && !bill.paid;
}

function billSource(bill) {
  if (bill.verifiedAmount || bill.amount_source === 'verified' || bill.source === 'verified') return 'verified amount';
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

function forecastPaychecks({ paychecks = [], incomeStreams = [], asOf, horizonDays = 45 }) {
  const cutoff = addDays(asOf, horizonDays);
  const explicit = paychecks
    .filter((paycheck) => validDate(paycheckDate(paycheck)) && paycheckDate(paycheck) >= asOf && paycheckDate(paycheck) <= cutoff)
    .map((paycheck) => ({
      date: paycheckDate(paycheck),
      amount: round(paycheckAmount(paycheck)),
      status: paycheckStatus(paycheck),
      basis: paycheckBasis(paycheck),
      confidence: paycheckStatus(paycheck) === 'verified' ? 'high' : paycheckStatus(paycheck) === 'incomplete' ? 'low' : 'medium',
    }));

  if (explicit.length) return explicit.sort((a, b) => a.date.localeCompare(b.date));

  return incomeStreams
    .filter((stream) => validDate(stream.next_expected) && stream.next_expected >= asOf && stream.next_expected <= cutoff)
    .map((stream) => ({
      date: stream.next_expected,
      amount: round(stream.typical_amount),
      status: 'forecast',
      basis: 'income stream history',
      confidence: 'low',
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function categorySpend(transactions, category, start, end) {
  return sum(transactions
    .filter((transaction) => {
      const date = transaction.posted_date || transaction.date;
      return date >= start && date < end
        && transaction.category === category
        && !transaction.pending
        && !transaction.is_transfer
        && !transaction.is_income
        && !transaction.parent_transaction_id
        && Number(transaction.amount) > 0;
    })
    .map((transaction) => transaction.amount));
}

function allowanceForWindow({ category, monthlyTarget, transactions, asOf, nextPayday }) {
  let cursor = asOf;
  let allowance = 0;
  while (cursor < nextPayday) {
    allowance += Number(monthlyTarget || 0) / monthDays(cursor);
    cursor = addDays(cursor, 1);
  }
  const spent = categorySpend(transactions, category, asOf, nextPayday);
  return {
    category,
    planned: round(allowance),
    spent,
    left: round(Math.max(0, allowance - spent)),
    overBy: round(Math.max(0, spent - allowance)),
    daysRemaining: daysBetween(asOf, nextPayday),
    label: spent > allowance ? `Over plan by $${round(spent - allowance).toFixed(2)}` : `$${round(Math.max(0, allowance - spent)).toFixed(2)} left until payday`,
  };
}

function assignBills({ bills, paychecks, asOf }) {
  const openBills = bills.filter((bill) => billIsOpen(bill) && validDate(billDueDate(bill)));
  const dueBeforeNext = [];
  const groups = new Map(paychecks.map((paycheck) => [paycheck.date, []]));
  const later = [];

  for (const bill of openBills) {
    const dueDate = billDueDate(bill);
    const eligible = paychecks.filter((paycheck) => paycheck.date <= dueDate);
    const latest = eligible.at(-1);
    const item = {
      ...bill,
      dueDate,
      amountDue: round(billAmount(bill)),
      amountSource: billSource(bill),
      confidence: confidenceForBill(bill),
    };

    if (dueDate < (paychecks[0]?.date || '9999-12-31')) dueBeforeNext.push(item);
    else if (latest) groups.get(latest.date).push(item);
    else later.push(item);
  }

  return {
    dueBeforeNext: dueBeforeNext.sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    groups: paychecks.map((paycheck) => ({
      paycheckDate: paycheck.date,
      bills: groups.get(paycheck.date),
      total: sum(groups.get(paycheck.date).map((bill) => bill.amountDue)),
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
  flexibleCategories = ['Groceries', 'Restaurants', 'Gas', 'Household/Fun'],
  transactions = [],
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
  const assignments = assignBills({ bills, paychecks: forecasts, asOf });
  const beforeNext = assignments.dueBeforeNext;
  const beforeNextTotal = sum(beforeNext.map((bill) => bill.amountDue));
  const assigned = nextPaycheck
    ? assignments.groups.find((group) => group.paycheckDate === nextPaycheck.date) || { bills: [], total: 0 }
    : { bills: [], total: 0 };

  const allowanceEnd = nextPaycheck?.date || addDays(asOf, 14);
  const allowances = flexibleCategories
    .filter((category) => Number(budgetTargets[category]) > 0)
    .map((category) => allowanceForWindow({
      category,
      monthlyTarget: budgetTargets[category],
      transactions,
      asOf,
      nextPayday: allowanceEnd,
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
      laterBills: assignments.later,
    },
    allowances,
    attention,
    diagnostics: {
      checkingBalanceIsAvailable: checkingAccounts.every((account) => accountBalance(account).available !== null),
      daysUntilNextPaycheck: nextPaycheck ? daysBetween(asOf, nextPaycheck.date) : null,
      projectedCheckingAtPayday,
    },
  };
}
