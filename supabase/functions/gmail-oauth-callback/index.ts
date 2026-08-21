/**
 * Gmail OAuth callback.
 *
 * Google redirects the browser here after consent with no Supabase session.
 * The one-time state row is therefore authoritative for both household and
 * member ownership.
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

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    const { data: stateRow, error: stateError } = await admin
      .from('oauth_states')
      .select('household_id, owner_user_id, created_at')
      .eq('state', state)
      .eq('provider_key', 'gmail')
      .maybeSingle();

    await admin.from('oauth_states').delete().eq('state', state);

    if (stateError || !stateRow || !stateRow.owner_user_id) return redirect('error', 'invalid_state');

    const ageMinutes = (Date.now() - Date.parse(stateRow.created_at)) / 60000;
    if (ageMinutes > STATE_TTL_MINUTES) return redirect('error', 'expired_state');

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
    if (!tokens.refresh_token) return redirect('error', 'no_refresh_token');

    const profileResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.emailAddress) return redirect('error', 'could_not_identify_account');

    const connectedEmail = profile.emailAddress;
    const householdId = stateRow.household_id;
    const ownerUserId = stateRow.owner_user_id;
    const tokenRef = `gmail_refresh_${householdId}_${await sha256Hex(connectedEmail)}`;

    const { error: vaultError } = await admin.rpc('store_vault_secret', {
      secret_name: tokenRef,
      secret_value: tokens.refresh_token,
    });
    if (vaultError) throw new Error(`could not store token: ${vaultError.message}`);

    const { error: connError } = await admin.from('provider_connections').upsert({
      household_id: householdId,
      owner_user_id: ownerUserId,
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
