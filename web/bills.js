/**
 * Bills: what the household owes, and what a parser wasn't confident enough
 * about to trust without a look.
 *
 * `active_bills` (migration 0003) already excludes paid, ignored, and
 * needs-review rows — the review queue is fetched separately so a
 * low-confidence parse can never silently count toward what's due.
 */
import { supabase, FUNCTIONS_URL } from './supabase-client.js';
import { rowToBill } from '../src/ingestion/bill-row-mapping.js';

export async function listBills() {
  const { data, error } = await supabase.from('active_bills').select('*').order('due_date');
  if (error) throw error;
  return (data ?? []).map(rowToBill);
}

export async function listBillsNeedingReview() {
  const { data, error } = await supabase
    .from('bills')
    .select('*')
    .eq('needs_review', true)
    .order('due_date');
  if (error) throw error;
  return (data ?? []).map(rowToBill);
}

/** Accept a low-confidence parse: it now counts toward what's owed. */
export async function confirmBill(id) {
  const { error } = await supabase.from('bills').update({ status: 'confirmed', needs_review: false }).eq('id', id);
  if (error) throw error;
}

/** Reject a false positive — a payment receipt or a promo that slipped through classification. */
export async function dismissBill(id) {
  const { error } = await supabase.from('bills').update({ status: 'ignored', needs_review: false }).eq('id', id);
  if (error) throw error;
}

/**
 * Extract provider/amount/due-date/category from pasted bill text — a
 * screenshot transcript, a portal page, an email body for a provider Gmail
 * scanning hasn't seen. Extraction only; nothing is saved until the
 * household reviews the fields and calls createBill().
 */
export async function parseBillText(text) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');

  const res = await fetch(`${FUNCTIONS_URL}/parse-bill-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ text }),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.message ?? result.error ?? 'parse-bill-text failed');
  return result;
}

/**
 * Save a bill entered by hand (with or without AI-assisted parsing first).
 * Always source='manual', confirmed, full confidence — a household typing or
 * confirming a number themselves needs no review queue, unlike a low-
 * confidence automated parse.
 */
export async function createBill({ providerName, amountDue, dueDate, category }) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');

  const { data: membership, error: membershipError } = await supabase
    .from('household_members')
    .select('household_id')
    .eq('user_id', session.user.id)
    .limit(1)
    .maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) throw new Error('Not in a household');

  const providerKey = providerName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  const { error } = await supabase.from('bills').insert({
    household_id: membership.household_id,
    provider_name: providerName.trim(),
    provider_key: providerKey || 'manual-entry',
    category: category || 'Other',
    amount_due: amountDue,
    due_date: dueDate,
    status: 'confirmed',
    source: 'manual',
    confidence: 1,
    needs_review: false,
  });
  if (error) throw error;
}
