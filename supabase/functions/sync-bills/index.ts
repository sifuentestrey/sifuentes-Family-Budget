/**
 * Daily bill sync from Gmail.
 *
 * For every household with a connected Gmail integration, refreshes a short-
 * lived access token from the Vault-held refresh token, then runs the same
 * search -> classify -> parse -> dedupe pipeline already tested offline in
 * tests/ingestion.test.mjs (ingestBillsFromEmail + syncBills, copied into
 * _shared/ by scripts/sync-shared.mjs — this file adds no bill-parsing logic
 * of its own, only the Postgres plumbing around it).
 *
 * Scheduled the same way sync-transactions is: pg_cron presents a Vault-held
 * bearer token, checked with the same fail-closed, constant-time comparison.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { extractText, getDocumentProxy } from 'npm:unpdf';
import { createGmailProvider } from '../_shared/providers/gmail-email-provider.js';
import { ingestBillsFromEmail } from '../_shared/ingestion/email-ingestion.js';
import { createPdfParser } from '../_shared/ingestion/pdf-parser.js';
import { syncBills } from '../_shared/sync/sync-engine.js';
import { billToRow, rowToBill } from '../_shared/ingestion/bill-row-mapping.js';

const INITIAL_LOOKBACK_DAYS = 90;
const STALE_RUN_MINUTES = 90;

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

const pdfParser = createPdfParser({ extractText: extractPdfText });

function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function expectedSecret(supabase: SupabaseClient): Promise<string | null> {
  const fromEnv = Deno.env.get('SYNC_SECRET');
  if (fromEnv) return fromEnv.trim();

  const { data, error } = await supabase.rpc('read_vault_secret', { secret_name: 'sync_secret' });
  if (error || typeof data !== 'string' || data.length === 0) return null;
  return data.trim();
}

async function refreshAccessToken(refreshToken: string, clientId: string, clientSecret: string) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  const result = await response.json();
  if (!response.ok) {
    const err: any = new Error(result.error_description ?? result.error ?? 'token refresh failed');
    err.code = result.error;
    throw err;
  }
  return result.access_token as string;
}

function syncRunToRow(run: any, connectionId: string) {
  return {
    household_id: run.householdId,
    connection_id: connectionId,
    provider_key: run.provider,
    kind: run.kind,
    started_at: run.startedAt,
    completed_at: run.completedAt ?? null,
    status: run.status,
    items_found: run.itemsFound,
    items_created: run.itemsCreated,
    items_updated: run.itemsUpdated,
    items_skipped: run.itemsSkipped,
    duplicates_detected: run.duplicatesDetected,
    provider_is_live: run.providerIsLive,
    errors: run.errors,
    duration_ms: run.durationMs ?? null,
  };
}

/** A SyncStore backed by Postgres, scoped to one connection's household. */
function createPostgresStore(admin: SupabaseClient, connectionId: string) {
  return {
    async recordRun(run: any) {
      const { data, error } = await admin
        .from('sync_runs')
        .insert(syncRunToRow(run, connectionId))
        .select('id')
        .single();
      if (error) throw new Error(`could not record sync run: ${error.message}`);
      run._dbId = data.id;
      return run;
    },

    async completeRun(run: any) {
      if (!run._dbId) return run;
      const { error } = await admin.from('sync_runs').update(syncRunToRow(run, connectionId)).eq('id', run._dbId);
      if (error) throw new Error(`could not complete sync run: ${error.message}`);
      return run;
    },

    async getExistingBills(householdId: string) {
      const { data, error } = await admin.from('bills').select('*').eq('household_id', householdId);
      if (error) throw new Error(`could not load existing bills: ${error.message}`);
      return (data ?? []).map(rowToBill);
    },

    async saveBills(bills: any[]) {
      if (!bills.length) return 0;
      const { error } = await admin.from('bills').insert(bills.map(billToRow));
      if (error) throw new Error(`could not save bills: ${error.message}`);
      return bills.length;
    },

    async updateBills(updates: { existing: any; candidate: any }[]) {
      let updated = 0;
      for (const { existing, candidate } of updates) {
        const row = billToRow({ ...existing, ...candidate, id: existing.id });
        const { error } = await admin.from('bills').update(row).eq('id', existing.id);
        if (error) throw new Error(`could not update bill ${existing.id}: ${error.message}`);
        updated++;
      }
      return updated;
    },
  };
}

/**
 * A process timeout can kill the function after recordRun() but before the
 * finally/completeRun path executes. Close those abandoned audit rows on the
 * next healthy invocation so the UI never says a three-day-old sync is still
 * running.
 */
async function closeStaleRuns(admin: SupabaseClient) {
  const cutoff = new Date(Date.now() - STALE_RUN_MINUTES * 60_000).toISOString();
  await admin
    .from('sync_runs')
    .update({
      status: 'error',
      completed_at: new Date().toISOString(),
      errors: [{ stage: 'sync', message: 'Previous sync ended without completion; closed by the next run.' }],
    })
    .eq('kind', 'bills')
    .eq('status', 'running')
    .lt('started_at', cutoff);
}

Deno.serve(async (req) => {
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const expected = await expectedSecret(admin);
  const presented = req.headers.get('Authorization') ?? '';
  if (!expected || !secretsMatch(presented, `Bearer ${expected}`)) {
    return new Response('unauthorized', { status: 401 });
  }

  await closeStaleRuns(admin);

  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')?.trim();
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')?.trim();
  if (!clientId || !clientSecret) {
    return json({ error: 'not_configured', message: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set.' }, 503);
  }

  const { data: connections, error: connError } = await admin
    .from('provider_connections')
    .select('id, household_id, token_ref, last_synced_at')
    .eq('provider_key', 'gmail')
    .eq('kind', 'email')
    .eq('status', 'connected');

  if (connError) return json({ error: 'internal', message: connError.message }, 500);

  const results = [];
  for (const connection of connections ?? []) {
    try {
      const refreshToken = await admin.rpc('read_vault_secret', { secret_name: connection.token_ref })
        .then(({ data, error }) => {
          if (error) throw new Error(`vault read failed: ${error.message}`);
          return data as string;
        });

      let accessToken: string | null = null;
      const getAccessToken = async () => {
        if (!accessToken) accessToken = await refreshAccessToken(refreshToken, clientId, clientSecret);
        return accessToken;
      };

      const provider = createGmailProvider({ getAccessToken });
      const store = createPostgresStore(admin, connection.id);

      const since = connection.last_synced_at
        ? new Date(connection.last_synced_at).toISOString().slice(0, 10)
        : new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);

      const emailIngester = (p: any, opts: any) => ingestBillsFromEmail(p, { ...opts, pdfParser });

      const run = await syncBills({
        provider, store, householdId: connection.household_id, since, emailIngester,
      });

      if (run.status === 'success' || run.status === 'partial') {
        await admin
          .from('provider_connections')
          .update({ last_synced_at: new Date().toISOString(), status: 'connected', status_detail: null })
          .eq('id', connection.id);
      }

      results.push({ householdId: connection.household_id, status: run.status, itemsCreated: run.itemsCreated, errors: run.errors });
    } catch (error: any) {
      const needsReauth = error.code === 'invalid_grant';
      await admin
        .from('provider_connections')
        .update({ status: needsReauth ? 'needs_reauth' : 'error', status_detail: error.message })
        .eq('id', connection.id);

      results.push({ householdId: connection.household_id, status: 'error', error: error.message });
    }
  }

  return json({ synced: results });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
