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

/**
 * Non-bank provider connections (currently just Gmail). Bank connections live
 * in `items`/`accounts` instead — this table is for everything added after,
 * so it stays provider-agnostic rather than growing a column per integration.
 */
export async function listProviderConnections() {
  const { data, error } = await supabase
    .from('provider_connections')
    .select('id, provider_key, display_name, kind, is_live, status, status_detail, connected_at, last_synced_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * Ask the advisor for a fresh check-in note, or answer a direct question.
 * The summary is built entirely client-side from the same engine output the
 * dashboard already renders — this call never sends raw transactions, only
 * the aggregate numbers.
 */
export async function getAdvisorNote(summary, question) {
  return callFunction('advisor-note', question ? { summary, question } : { summary });
}

/** Household-visible history of past advisor notes, most recent first. */
export async function listAdvisorNotes() {
  const { data, error } = await supabase
    .from('advisor_notes')
    .select('id, note, question, source, created_at')
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw error;
  return data ?? [];
}

/**
 * Start the Gmail OAuth flow. Unlike Plaid Link, this is a full-page redirect
 * rather than a popup/modal — Google's consent screen is designed to be
 * navigated to, not embedded, and gmail-oauth-callback redirects the browser
 * straight back here once it's done.
 */
export async function connectGmail() {
  const { url } = await callFunction('gmail-oauth-start');
  window.location.href = url;
}

/**
 * Drops one connection row (a household can have more than one Gmail
 * connection now, so this always targets a specific id — never all of a
 * provider_key at once) so the UI stops treating that address as connected
 * and the daily bill sync stops picking it up.
 *
 * Does not revoke the underlying Google grant or purge the stored refresh
 * token from Vault — reconnecting the same address overwrites it, and
 * revoking it entirely is one click at myaccount.google.com/permissions in
 * the meantime. Read-only mail scope, so the residual risk of a lingering
 * token is low; noted here rather than silently treated as fully handled.
 */
export async function disconnectGmail(id) {
  const { error } = await supabase.from('provider_connections').delete().eq('id', id);
  if (error) throw error;
}

export async function listConnectedItems() {
  const { data, error } = await supabase
    .from('items')
    .select('id, institution_name, status, status_detail, updated_at, accounts(id, nickname, mask, type, current_balance)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * The household's real transactions, already categorized and transfer/income
 * -tagged — sync-transactions runs the same categorize/detectTransfers/
 * markIncome pipeline server-side on every sync, so this is the settled
 * result, not raw Plaid data needing that pipeline run again client-side.
 *
 * category comes back as the name (joined from categories), matching the
 * shape the rest of the app already expects from the fixture path.
 */
export async function listTransactions() {
  const { data, error } = await supabase
    .from('transactions')
    .select(`
      id, plaid_transaction_id, account_id, posted_date, amount,
      raw_description, payee, categorized_by, is_transfer, transfer_pair_id,
      is_income, manually_categorized, parent_transaction_id, pending,
      logo_url, merchant_website,
      categories(name)
    `)
    .order('posted_date', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(({ categories, ...t }) => ({ ...t, category: categories?.name ?? null }));
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

/**
 * Ask the server to name the payees nothing recognised.
 *
 * Deliberately on demand rather than automatic: it costs a model call, and a
 * household that has just connected a bank does not need every historical
 * oddity resolved the moment they arrive. The nightly sweep does the same
 * work unprompted; this is the "do it now" button.
 *
 * Only ever touches rows still uncategorized, and only in this household —
 * enforced server-side against the caller's own token, not requested here.
 */
export async function categorizeUnknowns() {
  const { results } = await callFunction('categorize-llm');
  return (results ?? []).reduce(
    (acc, r) => ({
      categorized: acc.categorized + (r.categorized ?? 0),
      skipped: acc.skipped + (r.skipped ?? 0),
    }),
    { categorized: 0, skipped: 0 },
  );
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
