/**
 * Advisor summary — the aggregate shape the advisor prompt is built from.
 *
 * Runs the same pipeline web/app.js's buildPlan() runs client-side
 * (detectIncomeStreams -> modelIncomeStreams -> reliableMonthlyIncome ->
 * buildExpensePicture -> floorCoverage -> analyzeSubscriptions ->
 * calculateSafeToSpend), reduced to the aggregate numbers the advisor prompt
 * needs and nothing else — never a raw transaction leaves this function.
 *
 * Written once so the nightly check-in (advisor-daily, which has no browser
 * state to read and must derive everything from DB rows) and the dashboard
 * cannot silently drift into disagreeing about what a household's numbers
 * are. Input transactions are expected already categorized/transfer/income-
 * tagged, exactly as they arrive from Postgres after the nightly sync.
 */

import { detectIncomeStreams } from './income.js';
import { modelIncomeStreams, reliableMonthlyIncome } from './variable-income.js';
import { buildExpensePicture, floorCoverage } from './expenses.js';
import { analyzeSubscriptions } from './subscriptions.js';
import { buildAlerts } from './alerts.js';
import { calculateSafeToSpend } from './budget/safe-to-spend.js';
import { isSplitParent } from './split.js';

// Matches web/app.js's gatherSafeToSpendInputs() placeholder — neither side
// pulls a live Plaid balance yet. Kept identical so the two never disagree.
const PLACEHOLDER_BALANCE = 5000;

const monthKey = (d) => d.slice(0, 7);

export function buildDailySummary({ transactions = [], bills = [], syncHealth } = {}) {
  const months = [...new Set(transactions.map((t) => monthKey(t.posted_date)))].sort();
  const month = months.at(-1);

  const streams = modelIncomeStreams(detectIncomeStreams(transactions), transactions);
  const income = reliableMonthlyIncome(streams);
  const picture = buildExpensePicture(transactions);
  const coverage = floorCoverage(picture, income.reliable);
  const subs = analyzeSubscriptions(transactions);

  const variableStream = streams.find((s) => s.distribution.stability !== 'stable');
  const safeToSpend = variableStream && month
    ? calculateSafeToSpend(gatherSafeToSpendInputs({
      transactions, months, month, picture, streams, variableStream,
    }))
    : null;

  const alerts = buildAlerts({ bills, transactions, subscriptions: subs, syncHealth });

  const topCategories = [...picture.categories]
    .sort((a, b) => b.monthlyAverage - a.monthlyAverage)
    .slice(0, 6)
    .map((c) => ({ name: c.category, monthlyAverage: c.monthlyAverage, bucket: c.bucket }));

  return {
    safeToSpend: safeToSpend?.safeToSpend ?? null,
    safeToSpendStatus: safeToSpend?.status ?? null,
    reliableMonthlyIncome: income.reliable,
    monthlySurplus: coverage.fullSurplus,
    floorCoverageStatus: coverage.status,
    survivalMonthlyCost: picture.survivalMonthlyCost,
    trueMonthlyCost: picture.trueMonthlyCost,
    topCategories,
    subscriptionsAnnualCost: subs.totalAnnual,
    subscriptionCount: subs.subscriptions.length,
    priceIncreases: subs.priceIncreases.map((p) => ({
      payee: p.payee,
      changePercent: p.priceChange.changePercent,
      annualImpact: p.annualImpactOfIncrease,
    })),
    activeAlerts: [...alerts.urgent, ...alerts.inApp].slice(0, 6).map((a) => `${a.title}: ${a.body}`),
  };
}

/** Mirrors web/app.js's gatherSafeToSpendInputs() exactly, over DB rows instead of live state. */
function gatherSafeToSpendInputs({ transactions, months, month, picture, streams, variableStream }) {
  const pendingTxns = transactions.filter((t) => t.pending && t.amount > 0);
  const pendingOutflows = pendingTxns.reduce((sum, t) => sum + t.amount, 0);

  const variableCategories = ['Groceries', 'Gas', 'Dining Out'];
  const recentMonths = months.slice(-3).filter((m) => m < month);
  let variableDailyTotal = 0;
  let variableDayCount = 0;

  const parents = new Set(transactions.map((t) => t.parent_transaction_id).filter(Boolean));
  const spendingIn = (m) => transactions.filter((t) =>
    monthKey(t.posted_date) === m
    && !t.is_transfer && !t.is_income && !t.pending && t.amount > 0
    && !isSplitParent(t, parents));

  for (const m of recentMonths) {
    const txns = spendingIn(m).filter((t) => variableCategories.includes(t.category || ''));
    const monthTotal = txns.reduce((s, t) => s + t.amount, 0);
    const [y, mm] = m.split('-');
    const daysInMonth = new Date(+y, +mm, 0).getDate();
    variableDailyTotal += monthTotal / daysInMonth;
    variableDayCount += 1;
  }
  const dailyVariableSpend = variableDayCount > 0 ? variableDailyTotal / variableDayCount : 0;

  const sinkingFundContribution = picture?.monthly?.irregular ?? 0;
  const bufferTarget = (picture?.monthly?.necessary ?? 0) * 3;

  const horizon = variableStream.next_expected;
  const today = new Date().toISOString().slice(0, 10);
  const expectedIncomeBeforePayday = streams
    .filter((s) => s !== variableStream
      && s.next_expected && s.next_expected >= today && s.next_expected < horizon)
    .reduce((sum, s) => sum + (s.distribution?.floor ?? 0), 0);

  return {
    currentBalance: PLACEHOLDER_BALANCE,
    pendingOutflows: pendingOutflows > 0 ? pendingOutflows : 0,
    bills: [],
    dailyVariableSpend: Math.max(0, dailyVariableSpend),
    bufferTarget,
    bufferBalance: 0,
    savingsGoals: [],
    sinkingFundContribution,
    nextPayday: variableStream.next_expected,
    expectedIncomeBeforePayday,
    incomeBasis: 'floor',
  };
}
