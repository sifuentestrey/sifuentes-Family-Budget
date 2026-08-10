/**
 * Paystub entry and reconciliation.
 *
 * Kept beside shifts.js/connect.js for the same reason: this is the one place
 * that knows the database column names, so everywhere else works in the
 * domain shapes reconcile.js and forecast.js already expect.
 */
import { supabase } from './supabase-client.js';
import {
  stubToRow, rowToStub, deductionToRow, reconciliationToRow, rowToReconciliationSummary,
} from '../src/payroll/mapping.js';

/** Every paystub, most recent first, with its deductions joined on. */
export async function listPaystubs() {
  const [{ data: stubRows, error: stubError }, { data: deductionRows, error: dedError }] = await Promise.all([
    supabase.from('paystubs').select('*').order('pay_date', { ascending: false }),
    supabase.from('deductions').select('*'),
  ]);
  if (stubError) throw stubError;
  if (dedError) throw dedError;

  const byStub = new Map();
  for (const row of deductionRows ?? []) {
    if (!byStub.has(row.paystub_id)) byStub.set(row.paystub_id, []);
    byStub.get(row.paystub_id).push(row);
  }
  return (stubRows ?? []).map((row) => rowToStub(row, byStub.get(row.id) ?? []));
}

export async function savePaystub(stub, householdId) {
  const { data: stubRow, error: stubError } = await supabase
    .from('paystubs')
    .insert(stubToRow(stub, householdId))
    .select()
    .single();
  if (stubError) throw new Error(stubError.message);

  let deductionRows = [];
  if (stub.deductions?.length) {
    const rows = stub.deductions.map((d) => deductionToRow(d, householdId, stubRow.id));
    const { data, error } = await supabase.from('deductions').insert(rows).select();
    if (error) throw new Error(error.message);
    deductionRows = data ?? [];
  }

  return rowToStub(stubRow, deductionRows);
}

export async function listReconciliations() {
  const { data, error } = await supabase
    .from('paycheck_reconciliations')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(rowToReconciliationSummary);
}

export async function saveReconciliation(reconciliation, householdId, forecastId) {
  const { data, error } = await supabase
    .from('paycheck_reconciliations')
    .upsert(reconciliationToRow(reconciliation, householdId, forecastId), { onConflict: 'paystub_id' })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return rowToReconciliationSummary(data);
}
