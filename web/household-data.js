import { buildHouseholdContext, householdDate } from '../src/engine/household-context.js';
import { loadHouseholdPaychecks } from '../src/payroll/load-household-paychecks.js';

let cached = null;
let cachedFor = null;
let expiresAt = 0;
export function invalidateHouseholdData() { cached = null; expiresAt = 0; }

export async function loadHouseholdData(force = false) {
  const connect = await import('./connect.js');
  const session = await connect.getSession();
  if (!session) { invalidateHouseholdData(); cachedFor = null; return null; }
  const key = `${session.user.id}:${householdDate()}`;
  if (force || key !== cachedFor || Date.now() > expiresAt) invalidateHouseholdData();
  cachedFor = key;
  if (!cached) {
    expiresAt = Date.now() + 60_000;
    cached = (async () => {
      const [bills, targets, { supabase }] = await Promise.all([import('./bills.js'), import('./budget-targets.js'), import('./supabase-client.js')]);
      const [items, transactions, rawBills, suppressions, budgetTargets] = await Promise.all([
        connect.listConnectedItems(), connect.listTransactions(), bills.listBillsForCenter(), bills.listBillSuppressions(), targets.listBudgetTargets(),
      ]);
      const asOf = householdDate();
      let paychecks = [], payrollError = null;
      try { paychecks = await loadHouseholdPaychecks(supabase, transactions, asOf); }
      catch { payrollError = 'Payroll could not refresh; paycheck estimates use bank history.'; }
      const context = buildHouseholdContext({ asOf, items, transactions, rawBills, suppressions, budgetTargets, paychecks });
      return { connect, bills, items, transactions, rawBills, suppressions, budgetTargets, targets: budgetTargets,
        paychecks, context, payrollError, planningBills: context.planningBills, incomeStreams: context.incomeStreams };
    })().catch(error => { invalidateHouseholdData(); throw error; });
  }
  return cached;
}
window.addEventListener('family-budget:data-changed', invalidateHouseholdData);
window.addEventListener('focus', invalidateHouseholdData);
