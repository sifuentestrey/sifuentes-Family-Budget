/**
 * Bills: what the household owes, and what a parser wasn't confident enough
 * about to trust without a look.
 *
 * `active_bills` (migration 0003) already excludes paid, ignored, and
 * needs-review rows — the review queue is fetched separately so a
 * low-confidence parse can never silently count toward what's due.
 */
import { supabase, FUNCTIONS_URL } from './supabase-client.js';
import { rowToBill, billToRow } from '../src/ingestion/bill-row-mapping.js';
import { slugify } from '../src/domain/bill.js';
import { findDuplicateBill, shouldUpdateExisting } from '../src/ingestion/dedupe.js';

export async function listBills() {
  const { data, error } = await supabase.from('active_bills').select('*').order('due_date');
  if (error) throw error;
  return (data ?? []).map(rowToBill);
}

/**
 * Bills center history includes paid rows as well as open ones.
 *
 * The ordinary list intentionally reads `active_bills` so settled obligations
 * disappear from "what do we still owe?". The monthly Bills center answers a
 * different question — "what was paid this month?" — so it needs the original
 * rows too. Ignored and needs-review records are excluded because neither is a
 * household-confirmed obligation yet.
 */
export async function listBillsForCenter() {
  const { data, error } = await supabase
    .from('bills')
    .select('*')
    .eq('needs_review', false)
    .neq('status', 'ignored')
    .order('due_date');
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
 * A household edit outranks every automated parser.
 *
 * Keep the existing record/id so payment history and shared preferences stay
 * attached, but make the corrected name, amount, date and category the facts
 * every screen uses from now on.
 */
export async function updateBillDetails(id, {
  providerName, amountDue, dueDate, category,
}) {
  const name = String(providerName ?? '').trim();
  const amount = Number(amountDue);
  if (!name) throw new Error('Bill name is required');
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Enter a valid amount');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dueDate ?? ''))) throw new Error('Enter a valid due date');

  const { error } = await supabase
    .from('bills')
    .update({
      provider_name: name,
      provider_key: slugify(name) || 'manual-entry',
      amount_due: amount,
      due_date: dueDate,
      category: category || 'Other',
      status: 'confirmed',
      source: 'manual',
      confidence: 1,
      needs_review: false,
    })
    .eq('id', id);
  if (error) throw error;
}

/**
 * Store the household's planning facts without adding schema just for UI
 * preferences. `raw` is already the provider-agnostic JSON payload on a bill,
 * so a tiny namespaced object is the safest place for "autopay vs we pay it"
 * and "fixed vs variable" until those concepts need first-class columns.
 *
 * These are shared database values, not localStorage: both people in the
 * household see the same answer on their phones.
 */
export async function updateBillPreferences(id, patch = {}) {
  const { data, error: readError } = await supabase
    .from('bills')
    .select('raw')
    .eq('id', id)
    .maybeSingle();
  if (readError) throw readError;
  if (!data) throw new Error('Bill not found');

  const currentRaw = data.raw && typeof data.raw === 'object' ? data.raw : {};
  const currentPlanning = currentRaw.planning && typeof currentRaw.planning === 'object'
    ? currentRaw.planning
    : {};

  const planning = { ...currentPlanning };
  if (patch.paymentMode === 'auto' || patch.paymentMode === 'manual') {
    planning.paymentMode = patch.paymentMode;
  }
  if (patch.amountMode === 'fixed' || patch.amountMode === 'variable') {
    planning.amountMode = patch.amountMode;
  }

  const { error } = await supabase
    .from('bills')
    .update({ raw: { ...currentRaw, planning } })
    .eq('id', id);
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
 * Save a bill the household entered or accepted themselves — typed by hand,
 * AI-assisted from pasted text, or accepted from a recurring charge this app
 * spotted in their transactions (`source: 'bank'`). Always confirmed, always
 * full confidence: a household confirming a number themselves needs no review
 * queue, unlike a low-confidence automated parse.
 *
 * Checked against every existing bill for the household — any source, not
 * just other manual entries — before inserting. The same bill Gmail already
 * parsed and a household now types in by hand (or the reverse order) must
 * update one row, not sit alongside it as a second, uncoordinated "bill".
 * A manual entry wins that merge (see dedupe.js's shouldUpdateExisting) —
 * a human confirming a number outranks any automated parse — unless the
 * existing bill is already paid, in which case nothing is touched and the
 * caller is told why rather than silently doing nothing.
 */
export async function createBill({ providerName, amountDue, dueDate, category, source = 'manual' }) {
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

  const candidate = {
    householdId: membership.household_id,
    providerName: providerName.trim(),
    providerKey: slugify(providerName.trim()) || 'manual-entry',
    category: category || 'Other',
    amountDue,
    dueDate,
    status: 'confirmed',
    source,
    confidence: 1,
    needsReview: false,
    detectedAt: new Date().toISOString(),
  };

  const { data: existingRows, error: existingError } = await supabase
    .from('bills')
    .select('*')
    .eq('household_id', membership.household_id);
  if (existingError) throw existingError;

  const verdict = findDuplicateBill(candidate, (existingRows ?? []).map(rowToBill));
  if (verdict.isDuplicate) {
    const decision = shouldUpdateExisting(verdict.existing, candidate);
    if (!decision.update) {
      throw new Error(
        `This looks like the same bill as the existing ${verdict.existing.providerName} bill `
        + `(${decision.reason}) — not adding a duplicate.`,
      );
    }
    const row = billToRow({ ...verdict.existing, ...candidate, id: verdict.existing.id });
    const { error } = await supabase.from('bills').update(row).eq('id', verdict.existing.id);
    if (error) throw error;
    return verdict.existing.id;
  }

  const row = billToRow(candidate);
  delete row.id;
  const { data, error } = await supabase.from('bills').insert(row).select('id').single();
  if (error) throw error;
  return data.id;
}
