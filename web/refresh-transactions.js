import { supabase, FUNCTIONS_URL } from './supabase-client.js';

/**
 * Ask the server to pull Plaid now for only the signed-in household.
 *
 * The Edge Function also accepts the private scheduler secret for pg_cron, but
 * the browser only ever presents its normal Supabase session token. The server
 * resolves household membership from that token and never accepts a household
 * id from this request body.
 */
export async function requestTransactionSync() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Sign in before syncing accounts.');

  const res = await fetch(`${FUNCTIONS_URL}/sync-transactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: '{}',
  });

  const text = await res.text();
  let result = {};
  try { result = text ? JSON.parse(text) : {}; } catch { /* server error text below */ }
  if (!res.ok) {
    const message = result.message ?? result.error ?? text;
    throw new Error(message || 'Could not sync accounts.');
  }
  return result;
}
