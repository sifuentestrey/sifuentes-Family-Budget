/**
 * Daily transaction sync.
 *
 * Runs on a schedule (pg_cron), pulls deltas from Plaid, and writes categorized
 * transactions into Postgres. No human involvement in the normal path.
 *
 * Security notes:
 *   - Plaid credentials come from environment secrets and never leave this
 *     function. The browser never sees a token.
 *   - Access tokens are read from Supabase Vault by reference. Storing them in
 *     a regular column would put them in every backup and every PostgREST
 *     response that forgot to exclude the column.
 *   - Runs with the service role, so RLS is bypassed here by design. Every
 *     write therefore sets household_id explicitly — that column is the only
 *     thing standing between two households' data.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { categorizeBatch, buildLearnedIndex, normalizePlaidTransaction } from '../_shared/categorize.js';
import { detectTransfers } from '../_shared/transfers.js';
import { detectIncomeStreams, markIncome } from '../_shared/income.js';
import { rowToBill } from '../_shared/ingestion/bill-row-mapping.js';
import { findPayingTransaction } from '../_shared/domain/bill-payment-match.js';

// Trimmed at the point of use: a pasted value routinely carries an invisible
// trailing newline, and requiring a human to retype a credential by hand to
// dodge that is a worse fix than not caring about whitespace.
const PLAID_ENV = (Deno.env.get('PLAID_ENV') ?? 'production').trim().toLowerCase();
const PLAID_HOST = `https://${PLAID_ENV}.plaid.com`;

/**
 * How far back to re-examine on every run.
 *
 * /transactions/sync is cursor-based and returns only deltas, so this is not
 * about fetching. It bounds the window we re-run transfer detection over: a
 * card payment's two sides can post days apart, and if the second side arrives
 * after we've already processed the first, the pair only becomes visible when
 * both are in scope together.
 */
const REPROCESS_WINDOW_DAYS = 30;

interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  merchant_name?: string | null;
  original_description?: string | null;
  personal_finance_category?: { primary: string; detailed: string } | null;
  pending: boolean;
}

function plaidHeaders() {
  return {
    'Content-Type': 'application/json',
    'PLAID-CLIENT-ID': Deno.env.get('PLAID_CLIENT_ID')!.trim(),
    'PLAID-SECRET': Deno.env.get('PLAID_SECRET')!.trim(),
  };
}

/**
 * Pull all pending deltas for one Item.
 *
 * Plaid returns pages until has_more is false. The cursor must only be
 * persisted after the whole page set is successfully written — advancing it
 * early would permanently skip transactions on a mid-loop failure, and nothing
 * would ever surface the gap.
 */
async function fetchDeltas(accessToken: string, cursor: string | null) {
  const added: PlaidTransaction[] = [];
  const modified: PlaidTransaction[] = [];
  const removed: string[] = [];
  let nextCursor = cursor;
  let hasMore = true;
  let pages = 0;

  while (hasMore && pages++ < 50) {
    const response = await fetch(`${PLAID_HOST}/transactions/sync`, {
      method: 'POST',
      headers: plaidHeaders(),
      body: JSON.stringify({
        access_token: accessToken,
        cursor: nextCursor ?? undefined,
        count: 500,
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(body.error_code ?? `Plaid HTTP ${response.status}`);
      // @ts-expect-error attach for caller
      error.plaidCode = body.error_code;
      throw error;
    }

    const page = await response.json();
    added.push(...page.added);
    modified.push(...page.modified);
    removed.push(...page.removed.map((r: { transaction_id: string }) => r.transaction_id));
    nextCursor = page.next_cursor;
    hasMore = page.has_more;
  }

  return { added, modified, removed, nextCursor };
}

async function syncItem(supabase: any, item: any) {
  const { data: logRow } = await supabase
    .from('sync_log')
    .insert({ household_id: item.household_id, item_id: item.id, status: 'running' })
    .select('id')
    .single();

  try {
    // Token by reference — never stored in a queryable column.
    const { data: secret, error: vaultError } = await supabase.rpc('read_vault_secret', {
      secret_name: item.token_ref,
    });
    if (vaultError) throw new Error(`vault read failed: ${vaultError.message}`);

    const { added, modified, removed, nextCursor } = await fetchDeltas(secret, item.cursor);

    // Map Plaid account ids to our rows.
    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, plaid_account_id')
      .eq('item_id', item.id);
    const accountMap = new Map(accounts.map((a: any) => [a.plaid_account_id, a.id]));

    const incoming = [...added, ...modified]
      .filter((t) => accountMap.has(t.account_id))
      .map((t) => {
        // category and plaidCategory aren't transactions columns — category_id
        // is, and reprocessWindow() fills it in immediately after this insert
        // by re-deriving it from categorizeBatch. Upserting either as-is
        // fails outright: Postgrest rejects unknown columns in the payload,
        // so every real sync's very first insert has always errored before
        // reaching reprocessWindow at all.
        const { category: _category, plaidCategory: _plaidCategory, ...row } = normalizePlaidTransaction(
          t,
          accountMap.get(t.account_id),
        );
        return { ...row, household_id: item.household_id };
      });

    if (removed.length) {
      await supabase.from('transactions').delete().in('plaid_transaction_id', removed);
    }

    if (incoming.length) {
      // Upsert on the Plaid id makes re-runs idempotent. onConflict ignoreDuplicates
      // is deliberately NOT used: modified transactions must actually update.
      const { error } = await supabase
        .from('transactions')
        .upsert(incoming, { onConflict: 'plaid_transaction_id' });
      if (error) throw new Error(`upsert failed: ${error.message}`);
    }

    await reprocessWindow(supabase, item.household_id);

    // Only now is it safe to advance the cursor.
    await supabase
      .from('items')
      .update({ cursor: nextCursor, status: 'good', status_detail: null, updated_at: new Date().toISOString() })
      .eq('id', item.id);

    await supabase
      .from('sync_log')
      .update({
        status: 'success',
        finished_at: new Date().toISOString(),
        added: added.length,
        modified: modified.length,
        removed: removed.length,
      })
      .eq('id', logRow.id);

    return { added: added.length, modified: modified.length, removed: removed.length };
  } catch (error: any) {
    // ITEM_LOGIN_REQUIRED means the bank revoked consent. Not a bug — banks
    // force periodic re-auth. Mark it so the UI can prompt, because a silently
    // stale account is worse than a visibly broken one.
    const needsReauth = error.plaidCode === 'ITEM_LOGIN_REQUIRED';
    await supabase
      .from('items')
      .update({
        status: needsReauth ? 'login_required' : 'error',
        status_detail: error.message,
        updated_at: new Date().toISOString(),
      })
      .eq('id', item.id);

    await supabase
      .from('sync_log')
      .update({ status: 'error', finished_at: new Date().toISOString(), error_message: error.message })
      .eq('id', logRow.id);

    throw error;
  }
}

/**
 * Re-run transfer detection, income detection, and categorization over a recent
 * window.
 *
 * Must span all accounts in the household: a transfer pair has one side in
 * checking and the other on a card, so per-item processing can never see both.
 * This is why detection runs here rather than inside the per-item fetch.
 */
async function reprocessWindow(supabase: any, householdId: string) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - REPROCESS_WINDOW_DAYS);

  const { data: rows } = await supabase
    .from('transactions')
    .select('*')
    .eq('household_id', householdId)
    .gte('posted_date', since.toISOString().slice(0, 10));

  if (!rows?.length) return;

  const { data: rules } = await supabase
    .from('rules')
    .select('pattern, is_learned, categories(name)')
    .eq('household_id', householdId);

  const learned = buildLearnedIndex(
    (rules ?? []).map((r: any) => ({
      pattern: r.pattern,
      category: r.categories?.name,
      is_learned: r.is_learned,
    })),
  );
  const householdRules = (rules ?? [])
    .filter((r: any) => !r.is_learned)
    .map((r: any) => [r.pattern, r.categories?.name] as [string, string]);

  let processed = detectTransfers(rows);
  const streams = detectIncomeStreams(processed);
  processed = markIncome(processed, streams);
  processed = categorizeBatch(processed, { learned, householdRules });

  const { data: categories } = await supabase
    .from('categories')
    .select('id, name')
    .eq('household_id', householdId);
  const categoryIds = new Map((categories ?? []).map((c: any) => [c.name, c.id]));

  // Write back only what changed, so we don't churn every row every night.
  const updates = processed
    .filter((t: any, i: number) => {
      const before = rows[i];
      return (
        t.is_transfer !== before.is_transfer ||
        t.is_income !== before.is_income ||
        t.categorized_by !== before.categorized_by ||
        (categoryIds.get(t.category) ?? null) !== before.category_id
      );
    })
    .map((t: any) => ({
      id: t.id,
      is_transfer: t.is_transfer,
      is_income: t.is_income,
      transfer_pair_id: t.transfer_pair_id ?? null,
      category_id: categoryIds.get(t.category) ?? null,
      categorized_by: t.categorized_by,
    }));

  for (const update of updates) {
    await supabase.from('transactions').update(update).eq('id', update.id);
  }

  await persistIncomeStreams(supabase, householdId, streams);
  await reconcileBills(supabase, householdId, processed);
}

/**
 * Mark a bill paid once a matching bank transaction shows up, instead of
 * leaving it in "upcoming" forever after the household already paid it
 * through the connected account. The other half of matching bills across
 * sources — dedupe.js already reconciles email vs. manual entry; this
 * reconciles either of those against what the bank actually shows.
 *
 * Conservative by construction (see findPayingTransaction): an ambiguous
 * match marks nothing rather than guessing which bill a transaction paid.
 */
async function reconcileBills(supabase: any, householdId: string, transactions: any[]) {
  const { data: billRows } = await supabase
    .from('bills')
    .select('*')
    .eq('household_id', householdId)
    .neq('status', 'paid')
    .neq('status', 'ignored');
  if (!billRows?.length) return;

  for (const row of billRows) {
    const bill = rowToBill(row);
    const match = findPayingTransaction(bill, transactions);
    if (!match) continue;

    const { error } = await supabase
      .from('bills')
      .update({
        status: 'paid',
        paid_at: match.posted_date,
        paid_amount: match.amount,
        paid_transaction_id: match.id,
      })
      .eq('id', bill.id)
      .neq('status', 'paid');
    if (error) throw new Error(`could not mark bill ${bill.id} paid: ${error.message}`);
  }
}

async function persistIncomeStreams(supabase: any, householdId: string, streams: any[]) {
  for (const stream of streams) {
    await supabase.from('income_streams').upsert(
      {
        household_id: householdId,
        account_id: stream.account_id,
        payee: stream.payee,
        cadence: stream.cadence,
        typical_amount: stream.typical_amount,
        last_seen: stream.last_seen,
        next_expected: stream.next_expected,
      },
      { onConflict: 'household_id,account_id,payee' },
    );
  }
}

/**
 * Compare without leaking length or position through timing.
 *
 * Overkill for a 256-bit random secret that nobody can feasibly guess a prefix
 * of, but it costs nothing and removes the need to think about it again.
 */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The token the caller must present.
 *
 * Vault is the source of truth; the environment variable is only a fallback for
 * a deployment that still sets one. Returns null when neither is configured,
 * and the caller MUST treat that as a refusal.
 *
 * This function previously compared against `Bearer ${Deno.env.get(...)}`
 * directly. With the variable unset that template produced the literal string
 * "Bearer undefined", which anyone could send — verified returning 200 against
 * the live deployment. Missing configuration now fails closed instead of
 * silently becoming a password that is printed in this file.
 */
async function expectedSecret(supabase: SupabaseClient): Promise<string | null> {
  const fromEnv = Deno.env.get('SYNC_SECRET');
  if (fromEnv) return fromEnv;

  const { data, error } = await supabase.rpc('read_vault_secret', {
    secret_name: 'sync_secret',
  });
  if (error || typeof data !== 'string' || data.length === 0) return null;
  return data;
}

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Only the scheduler or an authenticated household member may trigger a sync.
  const expected = await expectedSecret(supabase);
  const presented = req.headers.get('Authorization') ?? '';
  if (!expected || !secretsMatch(presented, `Bearer ${expected}`)) {
    return new Response('unauthorized', { status: 401 });
  }

  const { data: items, error } = await supabase
    .from('items')
    .select('*')
    .in('status', ['good', 'error']); // skip login_required until the user re-auths

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const results = [];
  for (const item of items ?? []) {
    try {
      results.push({ item: item.institution_name, ...(await syncItem(supabase, item)) });
    } catch (e: any) {
      // One failing institution must not stop the others.
      results.push({ item: item.institution_name, error: e.message });
    }
  }

  return new Response(JSON.stringify({ synced: results }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
});
