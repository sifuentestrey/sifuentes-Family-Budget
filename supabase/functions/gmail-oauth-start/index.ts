/**
 * Start the Gmail OAuth flow.
 *
 * The callback has no Supabase session, so the one-time state row carries both
 * household and member ownership through the Google redirect.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')?.trim();
  if (!clientId) {
    return json({ error: 'not_configured', message: 'GOOGLE_CLIENT_ID is not set on this project.' }, 503);
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

    const { data: membership } = await userClient
      .from('household_members')
      .select('household_id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle();
    if (!membership) return json({ error: 'no_household', message: 'User is not in a household' }, 400);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const state = crypto.randomUUID();
    const { error: insertError } = await admin.from('oauth_states').insert({
      state,
      household_id: membership.household_id,
      owner_user_id: user.id,
      provider_key: 'gmail',
    });
    if (insertError) throw new Error(`could not start OAuth flow: ${insertError.message}`);

    const redirectUri = `${Deno.env.get('SUPABASE_URL')}/functions/v1/gmail-oauth-callback`;
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);

    return json({ url: url.toString() });
  } catch (error) {
    return json({ error: 'internal', message: error.message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
