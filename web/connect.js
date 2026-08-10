/**
 * Auth, household bootstrap, and Plaid Link.
 *
 * Kept separate from app.js's rendering/planning code so the "get real data
 * connected" concerns don't tangle with the "show the numbers" concerns.
 */
import { supabase, FUNCTIONS_URL } from './supabase-client.js';

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthChange(callback) {
  supabase.auth.onAuthStateChange((_event, session) => callback(session));
}

/**
 * @returns {Promise<{needsConfirmation: boolean}>} true when the project has
 *   email confirmation on (the default): signUp succeeds but returns no
 *   session until the user clicks the link in their inbox.
 */
export async function signUp(email, password) {
  // Without this, Supabase sends the confirmation link to the project's
  // dashboard-configured Site URL, which defaults to localhost and stays
  // that way until someone remembers to change it for production.
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  if (error) throw error;
  return { needsConfirmation: !data.session };
}

export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
}

/**
 * Find the caller's household, creating one on first sign-in.
 *
 * A brand-new user has no household yet, and RLS requires already being a
 * member to write to `households` or `household_members` — a chicken-and-egg
 * that only a SECURITY DEFINER function on the server can resolve safely.
 * See migration 0005_household_bootstrap.sql.
 */
export async function ensureHousehold() {
  const { data, error } = await supabase.rpc('bootstrap_household');
  if (error) throw error;
  return data;
}

export async function listConnectedItems() {
  const { data, error } = await supabase
    .from('items')
    .select('id, institution_name, status, status_detail, accounts(id, nickname, mask, type, current_balance)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * Household members, so the Connect tab can show who is actually in here.
 *
 * RLS scopes this to the caller's own household, so there is no filter to pass
 * and no way to widen it from the browser.
 */
export async function listMembers() {
  const { data, error } = await supabase
    .from('household_members')
    .select('user_id, display_name, created_at')
    .order('created_at');
  if (error) throw error;
  return data ?? [];
}

export async function listInvites() {
  const { data, error } = await supabase
    .from('household_invites')
    .select('id, email, created_at, expires_at, accepted_at')
    .is('accepted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * Issue an invite. The household is taken from the caller's own membership
 * inside the function — it is deliberately not a parameter, so this cannot be
 * used to add someone to a household the caller isn't in.
 */
export async function createInvite(email) {
  const { data, error } = await supabase.rpc('create_household_invite', { invite_email: email });
  if (error) throw new Error(error.message);
  return data;
}

export async function revokeInvite(id) {
  const { error } = await supabase.from('household_invites').delete().eq('id', id);
  if (error) throw error;
}

async function callFunction(name, body) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');

  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.message ?? result.error ?? `${name} failed`);
  return result;
}

let plaidScriptLoaded = null;

/**
 * Load Plaid's own Link script on first use, not at page load — same reason
 * the Supabase SDK is imported lazily. Nothing in this app should depend on
 * an external CDN until the user has actually asked to connect a bank.
 */
function loadPlaidScript() {
  if (window.Plaid) return Promise.resolve();
  if (!plaidScriptLoaded) {
    plaidScriptLoaded = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Could not load Plaid Link. Check your connection and try again.'));
      document.head.appendChild(script);
    });
  }
  return plaidScriptLoaded;
}

/**
 * Open Plaid Link and resolve with the exchange result once the user finishes
 * connecting a bank. Rejects (without throwing across the Link boundary) if
 * they close the modal without finishing — that is a normal outcome, not an
 * error the UI should alarm about.
 */
export async function connectBank() {
  const { link_token: linkToken } = await callFunction('plaid-link-token');
  await loadPlaidScript();

  const publicToken = await new Promise((resolve, reject) => {
    const handler = window.Plaid.create({
      token: linkToken,
      onSuccess: (public_token, metadata) => resolve({ public_token, institution: metadata.institution }),
      onExit: (err) => (err ? reject(new Error(err.error_message ?? 'Plaid Link closed')) : resolve(null)),
    });
    handler.open();
  });

  if (!publicToken) return null; // user closed the modal
  return callFunction('plaid-exchange', publicToken);
}
