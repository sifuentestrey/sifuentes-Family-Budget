/**
 * Paycheck-level money planning.
 *
 * Dashboard answers "what is true". This answers "what does the next check
 * need to do?" using the same bills, transaction history and shared category
 * targets the rest of the app already trusts.
 */
import { addDays, projectNext } from './cadence.js';
import { planPaycheckCoverage } from './bill-paycheck-plan.js';
import { buildAdaptiveBudget } from './adaptive-budget.js';

const ESSENTIAL_CATEGORIES = ['Groceries', 'Gas'];
const round = (n) => Math.round(Number(n || 0) * 100) / 100;

function daysBetween(a, b) {
  return Math.max(0, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000));
}

function timeline(streams = [], asOf, horizonDays = 70) {
  const cutoff = addDays(asOf, horizonDays);
  const dates = new Set();
  for (const stream of streams) {
    let date = stream.next_expected;
    let guard = 0;
    while (date && date < asOf && guard++ < 20) date = projectNext(date, stream.cadence);
    while (date && date <= cutoff && guard++ < 40) {
      dates.add(date);
      const next = projectNext(date, stream.cadence);
      if (!next || next <= date) break;
      date = next;
    }
  }
  return [...dates].sort();
}

function streamPaysOn(stream, date) {
  let cursor = stream.next_expected;
  let guard = 0;
  while (cursor && cursor < date && guard++ < 30) cursor = projectNext(cursor, stream.cadence);
  return cursor === date;
}

function paycheckAmountForDate(streams, date) {
  return round((streams ?? [])
    .filter((stream) => streamPaysOn(stream, date))
    .reduce((sum, stream) => sum + Number(stream.typical_amount || 0), 0));
}

function sevenDayCluster(bills = [], paycheckAmount = 0) {
  if (bills.length < 2) return null;
  const sorted = [...bills].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  let best = null;

  for (let start = 0; start < sorted.length; start += 1) {
    const window = sorted.filter((bill) => {
      const gap = daysBetween(sorted[start].dueDate, bill.dueDate);
      return bill.dueDate >= sorted[start].dueDate && gap <= 6;
    });
    const total = round(window.reduce((sum, bill) => sum + Number(bill.amountDue || 0), 0));
    if (!best || total > best.total) {
      best = {
        start: window[0]?.dueDate,
        end: window.at(-1)?.dueDate,
        total,
        count: window.length,
      };
    }
  }

  if (!best || best.count < 2) return null;
  const heavyByShare = paycheckAmount > 0 && best.total >= paycheckAmount * 0.35;
  return best.count >= 3 || heavyByShare ? best : null;
}

/**
 * @param {object} input
 * @param {object[]} input.transactions categorized bank transactions
 * @param {object[]} input.upcomingBills open bill/subscription obligations
 * @param {object[]} input.incomeStreams validated income streams
 * @param {Record<string,number>} input.budgetTargets shared category targets
 * @param {string} input.asOf YYYY-MM-DD
 */
export function buildMoneyPlanSummary({
  transactions = [], upcomingBills = [], incomeStreams = [], budgetTargets = {}, asOf,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf ?? ''))) throw new Error('asOf must be YYYY-MM-DD');

  const paydays = timeline(incomeStreams, asOf);
  const nextPayday = paydays[0] ?? null;
  const followingPayday = paydays[1] ?? (nextPayday ? addDays(nextPayday, 14) : null);
  const paycheckEstimate = nextPayday ? paycheckAmountForDate(incomeStreams, nextPayday) : 0;
  const coverage = planPaycheckCoverage(upcomingBills, incomeStreams, { asOf });
  const nextGroup = nextPayday
    ? coverage.groups.find((group) => group.paycheckDate === nextPayday) ?? { bills: [], total: 0 }
    : { bills: [], total: 0 };

  const cycleDays = nextPayday && followingPayday
    ? Math.max(1, daysBetween(nextPayday, followingPayday))
    : 14;
  const month = nextPayday?.slice(0, 7) ?? asOf.slice(0, 7);
  const adaptive = buildAdaptiveBudget({ transactions, targets: budgetTargets, month });

  let essentialsMonthly = 0;
  let essentialsLowMonthly = 0;
  let essentialsHighMonthly = 0;
  const essentialDetail = [];

  for (const category of ESSENTIAL_CATEGORIES) {
    const row = adaptive.rows.find((entry) => entry.category === category);
    const planned = Number(row?.planned || 0);
    if (!planned) continue;
    const low = Number(row?.typicalLow ?? planned);
    const high = Number(row?.typicalHigh ?? planned);
    essentialsMonthly += planned;
    essentialsLowMonthly += low || planned;
    essentialsHighMonthly += high || planned;
    essentialDetail.push({ category, monthly: planned, source: row?.source ?? 'adaptive' });
  }

  const monthScale = cycleDays / 30.4375;
  const essentials = {
    days: cycleDays,
    expected: round(essentialsMonthly * monthScale),
    low: round(essentialsLowMonthly * monthScale),
    high: round(essentialsHighMonthly * monthScale),
    detail: essentialDetail,
  };

  const billsTotal = round(nextGroup.total || 0);
  const uncommitted = round(paycheckEstimate - billsTotal - essentials.expected);
  const cluster = sevenDayCluster(nextGroup.bills, paycheckEstimate);

  return {
    nextPayday,
    followingPayday,
    paycheckEstimate,
    bills: {
      total: billsTotal,
      items: nextGroup.bills,
    },
    essentials,
    uncommitted,
    dueBeforeNextPayday: coverage.dueNow,
    heavyCluster: cluster,
  };
}
