/**
 * Transaction sync.
 *
 * Runs hourly from pg_cron and can also be triggered by a signed-in household
 * member from the app. Both callers use the same sync path; the difference is
 * scope. Cron may sync every household, while a user's JWT may only sync rows
 * belonging to households RLS says that user belongs to.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { categorizeBatch, buildLearnedIndex, normalizePlaidTransaction } from '../_shared/categorize.js';
import { detectTransfers } from '../_shared/transfers.js';
import { detectIncomeStreams, markIncome } from '../_shared/income.js';
import { rowToBill } from '../_shared/ingestion/bill-row-mapping.js';
import { findPayingTransaction } from '../_shared/domain/bill-payment-match.js';

const PLAID_ENV = (Deno.env.get('PLAID_ENV') ?? 'production').trim().toLowerCase();
const PLAID_HOST = `https://${PLAID_ENV}.plaid.com`;

/**
 * Income detection requires three occurrences. Thirty days can contain only two
 * biweekly paychecks, causing a valid income stream to disappear depending on
 * which day the sync runs. Four months gives every normal payroll cadence enough
 * evidence while still keeping hourly reprocessing comfortably bounded.
 *
 * Transfer detection also benefits from the wider history; Plaid itself is
 * still cursor-based, so this does not refetch 120 days from the bank.
 */
const REPROCESS_WINDOW_DAYS = 120;
const STALE_SYNC_MINUTES = 90;

const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  merchant_name?: string | null;
  original_description?: string | null;
  personal_finance_category?: { primary: string; detailed: string } | null;
  logo_url?: string | null;
  website?: string | null;
  pending: boolean;
}

function plaidHeaders() {
  return {
    'Content-Type': 'application/json',
    'PLAID-CLIENT-ID': Deno.env.get('PLAID_CLIENT_ID')!.trim(),
    'PLAID-SECRET': Deno.env.get('PLAID_SECRET')!.trim(),
  };
}

function mapAccountType(type: string, subtype: string | null) {
  if (type === 'credit') return 'credit';
  if (type === 'loan') return 'loan';
  if (type === 'depository') {
    if (subtype === 'savings' || subtype === 'money market' || subtype === 'cd') return 'savings';
    return 'checking';
  }
  return 'other';
}

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

/**
 * Refresh balances and the account roster before mapping transaction deltas.
 *
 * Previously accounts were only written during initial Plaid Link. That left
 * balances stale forever and, worse, meant a newly visible account under an
 * existing Item had no local account_id. The sync then filtered its transaction
 * out and advanced the cursor, permanently losing that delta. Upserting the
 * account roster first makes the mapping complete before the cursor can move.
 */
async function refreshAccounts(supabase: any, item: any, accessToken: string) {
  const response = await fetch(`${PLAID_HOST}/accounts/get`, {
    method: 'POST',
    headers: plaidHeaders(),
    body: JSON.stringify({ access_token: accessToken }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error_code ?? `Plaid accounts HTTP ${response.status}`);
    // @ts-expect-error attach for caller
    error.plaidCode = body.error_code;
    throw error;
  }

  const rows = (body.accounts ?? []).map((account: any) => ({
    household_id: item.household_id,
    item_id: item.id,
    plaid_account_id: account.account_id,
    nickname: account.name ?? account.official_name ?? 'Account',
    type: mapAccountType(account.type, account.subtype),
    mask: account.mask ? String(account.mask).slice(-4) : null,
    institution_name: item.institution_name ?? null,
    current_balance: account.balances?.current ?? null,
    available_balance: account.balances?.available ?? null,
    credit_limit: account.balances?.limit ?? null,
    is_active: true,
    updated_at: new Date().toISOString(),
  }));

  if (rows.length) {
    const { error } = await supabase
      .from('accounts')
      .upsert(rows, { onConflict: 'plaid_account_id' });
    if (error) throw new Error(`account refresh failed: ${error.message}`);
  }

  const { data: accounts, error: accountError } = await supabase
    .from('accounts')
    .select('id, plaid_account_id')
    .eq('item_id', item.id)
    .eq('is_active', true);
  if (accountError) throw new Error(`account map failed: ${accountError.message}`);
  return new Map((accounts ?? []).map((a: any) => [a.plaid_account_id, a.id]));
}

async function syncItem(supabase: any, item: any) {
  const { data: logRow, error: logError } = await supabase
    .from('sync_log')
    .insert({ household_id: item.household_id, item_id: item.id, status: 'running' })
    .select('id')
    .single();
  if (logError || !logRow) throw new Error(`could not create sync log: ${logError?.message ?? 'unknown error'}`);

  try {
    const { data: secret, error: vaultError } = await supabase.rpc('read_vault_secret', {
      secret_name: item.token_ref,
    });
    if (vaultError) throw new Error(`vault read failed: ${vaultError.message}`);

    const { added, modified, removed, nextCursor } = await fetchDeltas(secret, item.cursor);
    const accountMap = await refreshAccounts(supabase, item, secret);

    const changed = [...added, ...modified];
    const unknownAccountIds = [...new Set(changed
      .filter((transaction) => !accountMap.has(transaction.account_id))
      .map((transaction) => transaction.account_id))];
    if (unknownAccountIds.length) {
      // Do not advance the Plaid cursor when a delta cannot be mapped. Leaving
      // the cursor untouched guarantees the transaction is retried next sync.
      throw new Error(`account map incomplete for ${unknownAccountIds.length} Plaid account(s)`);
    }

    const incoming = changed.map((t) => {
      const { category: _category, plaidCategory: _plaidCategory, ...row } = normalizePlaidTransaction(
        t,
        accountMap.get(t.account_id),
      );
      return { ...row, household_id: item.household_id };
    });

    if (removed.length) {
      const { error } = await supabase
        .from('transactions')
        .delete()
        .eq('household_id', item.household_id)
        .in('plaid_transaction_id', removed);
      if (error) throw new Error(`remove failed: ${error.message}`);
    }

    if (incoming.length) {
      const { error } = await supabase
        .from('transactions')
        .upsert(incoming, { onConflict: 'plaid_transaction_id' });
      if (error) throw new Error(`upsert failed: ${error.message}`);
    }

    await reprocessWindow(supabase, item.household_id);

    const { error: cursorError } = await supabase
      .from('items')
      .update({ cursor: nextCursor, status: 'good', status_detail: null, updated_at: new Date().toISOString() })
      .eq('id', item.id);
    if (cursorError) throw new Error(`cursor update failed: ${cursorError.message}`);

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

async function reprocessWindow(supabase: any, householdId: string) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - REPROCESS_WINDOW_DAYS);

  const { data: rows, error: rowError } = await supabase
    .from('transactions')
    .select('*')
    .eq('household_id', householdId)
    .gte('posted_date', since.toISOString().slice(0, 10))
    .order('posted_date', { ascending: true });
  if (rowError) throw new Error(`reprocess load failed: ${rowError.message}`);
  if (!rows?.length) {
    await replaceIncomeStreams(supabase, householdId, []);
    return;
  }

  const { data: rules, error: ruleError } = await supabase
    .from('rules')
    .select('pattern, is_learned, categories(name)')
    .eq('household_id', householdId);
  if (ruleError) throw new Error(`rule load failed: ${ruleError.message}`);

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

  const { data: categories, error: categoryError } = await supabase
    .from('categories')
    .select('id, name')
    .eq('household_id', householdId);
  if (categoryError) throw new Error(`category load failed: ${categoryError.message}`);
  const categoryIds = new Map((categories ?? []).map((c: any) => [c.name, c.id]));

  const updates = processed
    .filter((t: any, i: number) => {
      const before = rows[i];
      return (
        t.is_transfer !== before.is_transfer ||
        t.is_income !== before.is_income ||
        t.transfer_pair_id !== before.transfer_pair_id ||
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
    const { error } = await supabase.from('transactions').update(update).eq('id', update.id);
    if (error) throw new Error(`transaction reprocess failed: ${error.message}`);
  }

  await replaceIncomeStreams(supabase, householdId, streams);
  await reconcileBills(supabase, householdId, processed);
}

async function reconcileBills(supabase: any, householdId: string, transactions: any[]) {
  const { data: billRows, error: billError } = await supabase
    .from('bills')
    .select('*')
    .eq('household_id', householdId)
    .neq('status', 'paid')
    .neq('status', 'ignored');
  if (billError) throw new Error(`bill reconciliation load failed: ${billError.message}`);
  if (!billRows?.length) return;

  let pool = transactions;
  for (const row of billRows) {
    const bill = rowToBill(row);
    const match = findPayingTransaction(bill, pool);
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
    pool = pool.filter((t: any) => t.id !== match.id);
  }
}

/**
 * The income_streams table is a materialized answer, not an append-only log.
 * Replace the household's answer each sync so an employer that stops paying or
 * a stream that no longer qualifies cannot live there forever.
 */
async function replaceIncomeStreams(supabase: any, householdId: string, streams: any[]) {
  const { error: deleteError } = await supabase
    .from('income_streams')
    .delete()
    .eq('household_id', householdId);
  if (deleteError) throw new Error(`could not reconcile income streams: ${deleteError.message}`);
  if (!streams.length) return;

  const rows = streams.map((stream) => ({
    household_id: householdId,
    account_id: stream.account_id,
    payee: stream.payee,
    cadence: stream.cadence,
    typical_amount: stream.typical_amount,
    last_seen: stream.last_seen,
    next_expected: stream.next_expected,
  }));
  const { error } = await supabase.from('income_streams').insert(rows);
  if (error) throw new Error(`could not store income streams: ${error.message}`);
}

function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function expectedSecret(supabase: SupabaseClient): Promise<string | null> {
  const fromEnv = Deno.env.get('SYNC_SECRET');
  if (fromEnv) return fromEnv.trim();

  const { data, error } = await supabase.rpc('read_vault_secret', {
    secret_name: 'sync_secret',
  });
  if (error || typeof data !== 'string' || data.length === 0) return null;
  return data.trim();
}

/**
 * Return the household scope this caller may sync.
 * null means cron/all households; an array means signed-in user scope.
 */
async function authorizedHouseholds(
  req: Request,
  admin: SupabaseClient,
): Promise<{ households: string[] | null; ok: boolean }> {
  const presented = req.headers.get('Authorization') ?? '';
  const expected = await expectedSecret(admin);

  if (expected && secretsMatch(presented, `Bearer ${expected}`)) {
    return { households: null, ok: true };
  }

  if (!expected && !presented.startsWith('Bearer ')) return { households: [], ok: false };
  if (!presented.startsWith('Bearer ')) return { households: [], ok: false };

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: presented } } },
  );
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return { households: [], ok: false };

  const { data: memberships, error: membershipError } = await userClient
    .from('household_members')
    .select('household_id');
  if (membershipError) return { households: [], ok: false };
  return {
    households: [...new Set((memberships ?? []).map((m: any) => m.household_id))],
    ok: true,
  };
}

async function closeStaleSyncLogs(admin: SupabaseClient, households: string[] | null) {
  const cutoff = new Date(Date.now() - STALE_SYNC_MINUTES * 60_000).toISOString();
  let query = admin
    .from('sync_log')
    .update({
      status: 'error',
      finished_at: new Date().toISOString(),
      error_message: 'Previous sync ended without completion; closed by the next sync.',
    })
    .eq('status', 'running')
    .lt('started_at', cutoff);
  if (households !== null) {
    if (!households.length) return;
    query = query.in('household_id', households);
  }
  await query;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { households, ok } = await authorizedHouseholds(req, admin);
  if (!ok) return json({ error: 'unauthorized' }, 401);
  if (households !== null && households.length === 0) return json({ synced: [] });

  await closeStaleSyncLogs(admin, households);

  let itemQuery = admin
    .from('items')
    .select('*')
    .in('status', ['good', 'error']);
  if (households !== null) itemQuery = itemQuery.in('household_id', households);

  const { data: items, error } = await itemQuery;
  if (error) return json({ error: error.message }, 500);

  const results = [];
  for (const item of items ?? []) {
    try {
      results.push({ item: item.institution_name, ...(await syncItem(admin, item)) });
    } catch (e: any) {
      results.push({ item: item.institution_name, error: e.message });
    }
  }

  return json({ synced: results });
});
