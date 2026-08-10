/**
 * Create a Plaid Link token.
 *
 * The browser needs a short-lived link_token to open Plaid Link. It must be
 * minted server-side: creating it requires the Plaid secret, and that secret
 * must never reach a browser.
 *
 * Products requested are `transactions` and `auth` — read only. `transfer` is
 * deliberately absent and a repository test fails the build if it ever appears.
 * Nothing in this system can move money, by construction rather than by policy.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

// Trimmed at the point of use, not just here: a value pasted from a chat
// message or a notes app routinely carries an invisible trailing newline, and
// Deno.env.get() returns it verbatim. Refusing to work until a human retypes a
// 24-character hex string by hand is a worse fix than simply not caring about
// whitespace that has no bearing on the credential itself.
const PLAID_ENV = (Deno.env.get('PLAID_ENV') ?? 'production').trim().toLowerCase();
const PLAID_HOST = `https://${PLAID_ENV}.plaid.com`;

const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const clientId = Deno.env.get('PLAID_CLIENT_ID')?.trim();
  const secret = Deno.env.get('PLAID_SECRET')?.trim();

  // Fail loudly and specifically. "Plaid is not configured" is actionable;
  // a generic 500 sends someone hunting through logs.
  if (!clientId || !secret) {
    return json({
      error: 'not_configured',
      message: 'PLAID_CLIENT_ID and PLAID_SECRET are not set on this project. ' +
        'Add them under Edge Functions → Secrets in the Supabase dashboard.',
    }, 503);
  }

  try {
    // Identify the caller from their JWT so the Link session is tied to a real
    // household member rather than an arbitrary id supplied by the client.
    const authHeader = req.headers.get('Authorization') ?? '';
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return json({ error: 'unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));

    const response = await fetch(`${PLAID_HOST}/link/token/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
      },
      body: JSON.stringify({
        user: { client_user_id: user.id },
        client_name: 'Family Budget',
        // Read-only. Never 'transfer'.
        products: ['transactions'],
        optional_products: ['auth'],
        country_codes: ['US'],
        language: 'en',
        // Present only when re-authorizing an existing Item after the bank
        // ends the connection.
        ...(body.accessTokenRef ? { access_token: body.accessTokenRef } : {}),
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      // Surface Plaid's own error code — it is far more diagnosable than a
      // generic failure, and contains no secret material.
      return json({
        error: result.error_code ?? 'plaid_error',
        message: result.error_message ?? 'Plaid rejected the request',
        display_message: result.display_message,
      }, response.status);
    }

    return json({ link_token: result.link_token, expiration: result.expiration });
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
