/**
 * Utility history access and forecasting.
 *
 * The browser only receives household-scoped bill rows through Supabase RLS.
 * Provider credentials, if a live adapter is ever approved, remain server-side.
 */
import { supabase } from './supabase-client.js';
import { forecastUtility, utilityPlanningAmount } from '../src/engine/utility-forecast.js';

const TYPE_BY_PROVIDER = Object.freeze({
  tvec: 'electric',
  watermark: 'water',
});

export async function listUtilityBills() {
  const { data, error } = await supabase
    .from('bills')
    .select('id,provider_name,provider_key,utility_type,amount_due,due_date,statement_date,source,source_message_id,confidence')
    .not('utility_type', 'is', null)
    .order('due_date', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(rowToUtilityBill);
}

export function forecastNextUtility({ provider, utilityType, bills, targetMonth }) {
  return forecastUtility({
    provider,
    utilityType: utilityType ?? TYPE_BY_PROVIDER[String(provider).toLowerCase()],
    bills,
    targetMonth,
  });
}

export { utilityPlanningAmount };

function rowToUtilityBill(row) {
  return {
    id: row.id,
    provider: row.provider_key ?? row.provider_name,
    providerName: row.provider_name,
    utilityType: row.utility_type,
    billDate: row.statement_date ?? row.due_date,
    dueDate: row.due_date,
    amount: Number(row.amount_due),
    source: sourceMap(row.source),
    sourceRef: row.source_message_id ?? row.id,
    confidence: Number(row.confidence ?? 0),
  };
}

function sourceMap(source) {
  if (source === 'provider_api' || source === 'provider_portal') return 'provider_api';
  if (source === 'email') return 'email_import';
  if (source === 'pdf') return 'pdf_import';
  return source === 'manual' ? 'manual' : 'transaction_match';
}
