// GENERATED FILE — do not edit.
// Source of truth: src/engine/household-context.js
// Regenerate with: npm run sync:shared
/** One household interpretation shared by Home, Plan and the advisor. */
import { buildHouseholdPlan } from './household-plan.js';
import { analyzeSubscriptions } from './subscriptions.js';
import { buildReliableSubscriptionStreams } from './reliable-subscriptions.js';
import { buildUpcomingObligations, obligationProvidersMatch, reconcileTrackedBills } from './bill-center.js';
import { detectIncomeStreams } from './income.js';
import { splitParentIds, isSplitParent } from './split.js';

export function householdDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function buildHouseholdContext({ asOf = householdDate(), items = [], transactions = [], rawBills = [], suppressions = [], budgetTargets = {}, paychecks = [] } = {}) {
  const suppressed = name => suppressions.some(m => obligationProvidersMatch(m.providerName, name));
  const recurring = [...(analyzeSubscriptions(transactions).bills ?? []),
    ...buildReliableSubscriptionStreams(transactions, { asOf })].filter(s => !suppressed(s.payee));
  const bills = rawBills.filter(b => !suppressed(b.providerName));
  const obligations = buildUpcomingObligations({ bills, recurring, transactions, asOf });
  const reconciledBills = reconcileTrackedBills(bills, transactions, recurring);
  const tracked = reconciledBills
    .filter(b => b.dueDate && (b.dueDate >= asOf || !b.paid));
  const planningBills = [...tracked, ...obligations.filter(o => !tracked.some(b =>
    obligationProvidersMatch(b.providerName, o.providerName) && b.dueDate === o.dueDate))];
  const incomeStreams = detectIncomeStreams(transactions);
  const accounts = items.flatMap(i => (i.accounts ?? []).map(a => ({ ...a, institution: i.institution_name })));
  let plan = buildHouseholdPlan({ asOf, accounts, bills: planningBills, includePaidBills: true,
    incomeStreams, budgetTargets, transactions, paychecks });
  // A starting suggestion is anchored to the paycheck window, never recalculated from today.
  const suggestedBudgetTargets = {};
  const cutoff = plan.budgetWindow.start;
  const since = new Date(Date.parse(cutoff) - 60 * 86400000).toISOString().slice(0, 10);
  const parents = splitParentIds(transactions);
  const history = transactions.filter(t => (t.posted_date || t.date) >= since && (t.posted_date || t.date) < cutoff
    && !t.is_transfer && !t.is_income && !t.pending && !isSplitParent(t, parents));
  for (const category of ['Groceries', 'Dining Out', 'Gas', 'Household/Fun']) {
    if (budgetTargets[category] != null) continue;
    const charges = history.filter(t => t.category === category);
    if (charges.length < 3) continue;
    const amount = charges.reduce((sum, t) => sum + Number(t.amount || 0), 0) / 2;
    if (amount > 0) suggestedBudgetTargets[category] = Math.ceil(amount / 10) * 10;
  }
  if (Object.keys(suggestedBudgetTargets).length) {
    plan = buildHouseholdPlan({ asOf, accounts, bills: planningBills, includePaidBills: true,
      incomeStreams, budgetTargets: { ...suggestedBudgetTargets, ...budgetTargets }, transactions, paychecks });
    plan.allowances = plan.allowances.map(a => ({ ...a, suggested: suggestedBudgetTargets[a.category] != null }));
  }
  const latestTransaction = transactions.map(t => t.posted_date || t.date).filter(Boolean).sort().at(-1) || null;
  const latestSync = items.map(i => i.updated_at).filter(Boolean).sort()[0] || null;
  const syncAgeDays = latestSync ? Math.max(0, (Date.parse(asOf) - Date.parse(latestSync.slice(0, 10))) / 86400000) : null;
  return { asOf, plan, obligations, recurring, bills, reconciledBills, planningBills, incomeStreams,
    suggestedBudgetTargets,
    dataHealth: { latestTransaction, latestSync, stale: syncAgeDays === null || syncAgeDays > 2,
      missingBudgetTargets: Object.keys(budgetTargets).length === 0 } };
}
