/**
 * Budget targets, shared across the household.
 *
 * A target is an agreement between the two people in the household, so it
 * lives in the database behind the same RLS as everything else here rather
 * than in one person's browser. Both phones read the same numbers, and a
 * change made on either one shows up on the other.
 *
 * Loaded lazily like bills.js and shifts.js — this pulls in the Supabase SDK
 * from a CDN, and the rest of the app is designed to run on fixtures with no
 * network at all.
 */
import { supabase } from './supabase-client.js';

/** @returns {Promise<Record<string, number>>} category -> monthly target */
export async function listBudgetTargets() {
  const { data, error } = await supabase.from('budget_targets').select('category, amount');
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((r) => [r.category, Number(r.amount)]));
}

/**
 * Set or replace one target. Upsert on the (household, category) key, so
 * editing a target updates it rather than accumulating a row per edit — a
 * target is current intent, not history.
 */
export async function saveBudgetTarget(householdId, category, amount) {
  const { error } = await supabase.from('budget_targets').upsert({
    household_id: householdId,
    category,
    amount,
    updated_at: new Date().toISOString(),
    updated_by: (await supabase.auth.getUser()).data.user?.id ?? null,
  }, { onConflict: 'household_id,category' });
  if (error) throw error;
}

/** Back to "use our own average" for this category. */
export async function clearBudgetTarget(householdId, category) {
  const { error } = await supabase
    .from('budget_targets')
    .delete()
    .eq('household_id', householdId)
    .eq('category', category);
  if (error) throw error;
}
