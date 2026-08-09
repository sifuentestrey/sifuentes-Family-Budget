/**
 * Exchange a Plaid public_token for an access_token and record the connection.
 *
 * Called once, immediately after the household finishes Plaid Link in the
 * browser. The public_token the browser holds is short-lived and useless on its
 * own; the durable access_token is minted here and goes straight into Vault.
 *
 * The access_token is never returned to the caller, never logged, and never
 * written to an ordinary column — `items.token_ref` holds only the Vault key.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const PLAID_ENV = Deno.env.get('PLAID_ENV') ?? 'production';
const PLAID_HOST = `https://${PLAID_ENV}.plaid.com`;

const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** Plaid account types mapped onto ours. */
function mapAccountType(type: string, subtype: string | null) {
  if (type === 'credit') return 'credit';
  if (type === 'loan') return 'loan';
  if (type === 'depository') {
    if (subtype === 'savings' || subtype === 'money market' || subtype === 'cd') return 'savings';
    return 'checking';
  }
  return 'other';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const clientId = Deno.env.get('PLAID_CLIENT_ID');
  const secret = Deno.env.get('PLAID_SECRET');
  if (!clientId || !secret) {
    return json({
      error: 'not_configured',
      message: 'PLAID_CLIENT_ID and PLAID_SECRET are not set on this project.',
    }, 503);
  }

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return json({ error: 'unauthorized' }, 401);

    // Household comes from the caller's membership, read through their own
    // RLS context. Trusting a household_id from the request body would let any
    // signed-in user attach accounts to someone else's household.
    const { data: membership } = await userClient
      .from('household_members')
      .select('household_id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle();

    if (!membership) return json({ error: 'no_household', message: 'User is not in a household' }, 400);
    const householdId = membership.household_id;

    const { public_token: publicToken, institution } = await req.json();
    if (!publicToken) return json({ error: 'missing_public_token' }, 400);

    const plaidHeaders = {
      'Content-Type': 'application/json',
      'PLAID-CLIENT-ID': clientId,
      'PLAID-SECRET': secret,
    };

    const exchange = await fetch(`${PLAID_HOST}/item/public_token/exchange`, {
      method: 'POST',
      headers: plaidHeaders,
      body: JSON.stringify({ public_token: publicToken }),
    });
    const exchanged = await exchange.json();

    if (!exchange.ok) {
      return json({
        error: exchanged.error_code ?? 'exchange_failed',
        message: exchanged.error_message ?? 'Could not exchange the public token',
      }, exchange.status);
    }

    const accessToken: string = exchanged.access_token;
    const plaidItemId: string = exchanged.item_id;

    // Service role from here: writing the Item and its accounts, and storing
    // the token in Vault, both require privileges the user does not have.
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const tokenRef = `plaid_item_${plaidItemId}`;
    const { error: vaultError } = await admin.rpc('store_vault_secret', {
      secret_name: tokenRef,
      secret_value: accessToken,
    });
    if (vaultError) throw new Error(`could not store token: ${vaultError.message}`);

    const { data: item, error: itemError } = await admin
      .from('items')
      .upsert({
        household_id: householdId,
        plaid_item_id: plaidItemId,
        institution_id: institution?.institution_id ?? null,
        institution_name: institution?.name ?? 'Connected bank',
        token_ref: tokenRef,
        status: 'good',
      }, { onConflict: 'plaid_item_id' })
      .select('id')
      .single();
    if (itemError) throw new Error(`could not save connection: ${itemError.message}`);

    // Pull the account list now so the household sees what connected straight
    // away rather than waiting for the first nightly sync.
    const accountsResponse = await fetch(`${PLAID_HOST}/accounts/get`, {
      method: 'POST',
      headers: plaidHeaders,
      body: JSON.stringify({ access_token: accessToken }),
    });
    const accountsResult = await accountsResponse.json();

    let accountCount = 0;
    if (accountsResponse.ok) {
      const rows = (accountsResult.accounts ?? []).map((a: any) => ({
        household_id: householdId,
        item_id: item.id,
        plaid_account_id: a.account_id,
        nickname: a.name ?? a.official_name ?? 'Account',
        type: mapAccountType(a.type, a.subtype),
        // Last 4 only, always.
        mask: a.mask ? String(a.mask).slice(-4) : null,
        institution_name: institution?.name ?? null,
        current_balance: a.balances?.current ?? null,
        available_balance: a.balances?.available ?? null,
        credit_limit: a.balances?.limit ?? null,
      }));

      if (rows.length) {
        const { error } = await admin
          .from('accounts')
          .upsert(rows, { onConflict: 'plaid_account_id' });
        if (error) throw new Error(`could not save accounts: ${error.message}`);
        accountCount = rows.length;
      }
    }

    // Deliberately returns no token material — only what the UI needs to
    // confirm the connection worked.
    return json({
      connected: true,
      institution: institution?.name ?? 'Connected bank',
      accounts: accountCount,
      item_id: item.id,
    });
  } catch (error) {
    return json({ error: 'internal', message: error.message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
