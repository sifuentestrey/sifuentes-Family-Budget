/**
 * Shift logging: pay profile and time entries.
 *
 * Kept beside connect.js rather than inside app.js for the same reason — this
 * file is the only place that knows the database column names, so the rest of
 * the app works in the domain shapes the payroll engine already expects.
 *
 * The mapping is not incidental. The engine speaks camelCase domain objects and
 * Postgres speaks snake_case columns; translating in one place means a schema
 * rename touches this file and nothing else.
 */
import { supabase } from './supabase-client.js';
import {
  rowToProfile, profileToRow, rowToEntry, entryToRow,
} from '../src/payroll/mapping.js';

/** The household's active pay profile, or null if none has been set up. */
export async function getPayProfile() {
  const { data, error } = await supabase
    .from('pay_profiles')
    .select('*')
    .eq('is_active', true)
    .order('created_at')
    .limit(1);
  if (error) throw error;
  return data?.length ? rowToProfile(data[0]) : null;
}

export async function savePayProfile(profile, householdId, existingId) {
  const row = profileToRow(profile, householdId);
  const query = existingId
    ? supabase.from('pay_profiles').update(row).eq('id', existingId).select().single()
    : supabase.from('pay_profiles').insert(row).select().single();

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return rowToProfile(data);
}

/**
 * Entries for one pay period. Scoped by date rather than fetching everything,
 * because the forecast only ever looks at a single period and a year of shifts
 * is a lot of rows to drag to a phone.
 */
export async function listTimeEntries(periodStart, periodEnd) {
  const { data, error } = await supabase
    .from('time_entries')
    .select('*')
    .gte('entry_date', periodStart)
    .lte('entry_date', periodEnd)
    .order('entry_date');
  if (error) throw error;
  return (data ?? []).map(rowToEntry);
}

export async function saveTimeEntry(entry, householdId, payProfileId) {
  const { data, error } = await supabase
    .from('time_entries')
    .insert(entryToRow(entry, householdId, payProfileId))
    .select()
    .single();
  if (error) throw new Error(error.message);
  return rowToEntry(data);
}

export async function deleteTimeEntry(id) {
  const { error } = await supabase.from('time_entries').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
