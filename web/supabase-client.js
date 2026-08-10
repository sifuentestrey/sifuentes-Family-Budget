/**
 * Supabase client for the browser.
 *
 * The publishable/anon key is meant to be public — it identifies the project,
 * not a user. Every table it can reach is behind RLS, so the key alone grants
 * no access to anyone else's household data.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://ytkpthlhtbxtvtadepqt.supabase.co';
// The modern publishable-key format, not the legacy JWT-shaped anon key —
// both are safe to ship to the browser, but this one doesn't look like a
// credential at a glance, which is what actually matters for anyone auditing
// this file later.
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_Sgswef5k8DDChXSeU7-2Sg_yBbGMeOg';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
