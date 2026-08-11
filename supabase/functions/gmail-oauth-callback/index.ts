/**
 * Gmail OAuth callback.
 *
 * Google redirects the browser here after consent — a plain GET with no
 * Supabase session attached, so `state` (minted and recorded by
 * gmail-oauth-start) is the only thing identifying which household this
 * belongs to. The state row is deleted the moment it's read, before any other
 * await, so a duplicated or retried callback can never redeem it twice.
 *
 * Unauthenticated by design (verify_jwt = false in config.toml) — Google's
 * redirect cannot carry a bearer token, and the state row is the real guard.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const APP_URL = Deno.env.get('APP_REDIRECT_URL')?.trim()
  || 'https://sifuentestrey.github.io/sifuentes-Family-Budget/web/index.html';

const STATE_TTL_MINUTES = 15;

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const googleError = url.searchParams.get('error');

  if (googleError) return redirect('denied', googleError);
  if (!code || !state) return redirect('error', 'missing_code_or_state');

  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')?.trim();
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')?.trim();
  if (!clientId || !clientSecret) return redirect('error', 'not_configured');

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const { data: stateRow, error: stateError } = await admin
      .from('oauth_states')
      .select('household_id, created_at')
      .eq('state', state)
      .eq('provider_key', 'gmail')
      .maybeSingle();

    // Delete immediately, before the token exchange, so a retried callback
    // (a user double-clicking back, Google's own retry on a slow response)
    // never gets a second chance to redeem the same state.
    await admin.from('oauth_states').delete().eq('state', state);

    if (stateError || !stateRow) return redirect('error', 'invalid_state');

    const ageMinutes = (Date.now() - Date.parse(stateRow.created_at)) / 60000;
    if (ageMinutes > STATE_TTL_MINUTES) return redirect('error', 'expired_state');

    // Must match gmail-oauth-start's redirect_uri exactly — Google rejects the
    // exchange otherwise.
    const redirectUri = `${Deno.env.get('SUPABASE_URL')}/functions/v1/gmail-oauth-callback`;
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenResponse.json();

    if (!tokenResponse.ok) return redirect('error', tokens.error ?? 'token_exchange_failed');

    if (!tokens.refresh_token) {
      // Google issues a refresh token only on the first consent for a given
      // account+scope pair. gmail-oauth-start always sends prompt=consent
      // specifically to avoid this, so reaching here means something is off —
      // failing loudly beats silently storing a connection that works for one
      // hour and then goes quiet with no way to refresh it.
      return redirect('error', 'no_refresh_token');
    }

    // Which Gmail address this is, not just which household — a household
    // can have more than one connection (e.g. both members' inboxes), and
    // without this every connection would collide on the same row. The
    // gmail.readonly scope already grants users.getProfile; no extra scope
    // needed.
    const profileResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.emailAddress) {
      return redirect('error', 'could_not_identify_account');
    }
    const connectedEmail = profile.emailAddress;

    const householdId = stateRow.household_id;
    // Derived from the email (hashed, since Vault secret names may not
    // accept every character an address can contain) rather than random —
    // reconnecting the same address then reuses the same secret name, so
    // store_vault_secret's own "delete before create" replaces the old
    // token cleanly. A random name here would leak the previous token: the
    // connection row would point at the new secret, but nothing would ever
    // clean up the old one under its old name.
    const tokenRef = `gmail_refresh_${householdId}_${await sha256Hex(connectedEmail)}`;

    const { error: vaultError } = await admin.rpc('store_vault_secret', {
      secret_name: tokenRef,
      secret_value: tokens.refresh_token,
    });
    if (vaultError) throw new Error(`could not store token: ${vaultError.message}`);

    const { error: connError } = await admin.from('provider_connections').upsert({
      household_id: householdId,
      provider_key: 'gmail',
      external_account_id: connectedEmail,
      display_name: connectedEmail,
      kind: 'email',
      is_live: true,
      status: 'connected',
      status_detail: null,
      token_ref: tokenRef,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'household_id,provider_key,external_account_id' });
    if (connError) throw new Error(`could not save connection: ${connError.message}`);

    return redirect('connected');
  } catch (error) {
    return redirect('error', error.message);
  }
});

function redirect(status: string, detail?: string) {
  const target = new URL(APP_URL);
  target.searchParams.set('gmail', status);
  if (detail) target.searchParams.set('gmail_detail', detail);
  return new Response(null, { status: 302, headers: { Location: target.toString() } });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
