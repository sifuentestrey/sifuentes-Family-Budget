/**
 * Daily alert email.
 *
 * Reuses buildAlerts()/composeAlertEmail() (src/engine/alerts.js, already
 * tested offline) — this file only assembles the inputs those pure functions
 * need and does the sending. Scoped to bill alerts for now: bills map onto
 * the engine's shape cleanly through the same bill-row-mapping.js sync-bills
 * already uses. Subscription and large-transaction alerts need a
 * transactions-row -> engine-transaction mapper that doesn't exist yet — the
 * browser normalizes those straight from raw Plaid JSON, never from a
 * Postgres row — so they're not included here yet; the in-app dashboard
 * still shows them, only the emailed subset is narrower.
 *
 * "Already emailed" tracking reuses buildAlerts()'s own dismissal mechanism:
 * `sent_alerts` holds the same alert `key`s the browser's dismissedAlerts
 * localStorage set holds, so an alert already emailed today doesn't repeat
 * tomorrow for no new reason — only a key change (due-soon -> overdue, a
 * genuinely more urgent state) does.
 *
 * Scheduled like sync-transactions/sync-bills: pg_cron presents a Vault-held
 * bearer token, checked with the same fail-closed, constant-time comparison.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { buildAlerts, composeAlertEmail } from '../_shared/alerts.js';
import { rowToBill } from '../_shared/ingestion/bill-row-mapping.js';
import { sendPush } from '../_shared/web-push.ts';

/**
 * The VAPID public key. Public by design — it ships in the browser too, and
 * the pair is only useful with the private half, which lives in Vault.
 */
const VAPID_PUBLIC_KEY = 'BOvSQ583cM8oj9s4nXj6eEahV8T8Imr9s7ZKww39GIs3wZJwwkC26IsMWiUJwUCML-KCebPpgto0Qk6LOColxww';

/**
 * Push the urgent alerts to every device the household has registered.
 *
 * Only the urgent ones. Email can carry the full digest because it waits to
 * be read; a notification interrupts, and a household that gets buzzed about
 * a subscription price rise stops reading the one that says rent is due
 * tomorrow and the account is short.
 */
async function pushToHousehold(admin: SupabaseClient, householdId: string, alerts: any[]) {
  if (!alerts.length) return { pushed: 0 };

  const { data: privateKey } = await admin.rpc('read_vault_secret', { secret_name: 'vapid_private_key' });
  if (typeof privateKey !== 'string' || !privateKey) return { pushed: 0, error: 'no VAPID key' };

  const { data: subs } = await admin
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('household_id', householdId)
    .is('expired_at', null);
  if (!subs?.length) return { pushed: 0 };

  // One notification carrying the most urgent item, not one per alert. Three
  // notifications arriving together is how notifications get turned off.
  const lead = alerts[0];
  const payload = {
    title: lead.title,
    body: alerts.length > 1 ? `${lead.body} (+${alerts.length - 1} more)` : lead.body,
    tag: lead.key,
    url: './index.html',
  };

  let pushed = 0;
  for (const sub of subs) {
    const result = await sendPush(sub, payload, {
      publicKey: VAPID_PUBLIC_KEY,
      privateKey,
      subject: `mailto:${Deno.env.get('ALERT_FROM_EMAIL')?.trim() || 'alerts@familybudget.app'}`,
    });

    if (result.ok) {
      pushed += 1;
      await admin.from('push_subscriptions')
        .update({ last_sent_at: new Date().toISOString() })
        .eq('endpoint', sub.endpoint);
    } else if (result.gone) {
      // The device is gone. Retrying it nightly forever is how a log fills
      // with errors nobody reads.
      await admin.from('push_subscriptions')
        .update({ expired_at: new Date().toISOString() })
        .eq('endpoint', sub.endpoint);
    }
  }
  return { pushed };
}

function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function expectedSecret(supabase: SupabaseClient): Promise<string | null> {
  const fromEnv = Deno.env.get('SYNC_SECRET');
  if (fromEnv) return fromEnv;

  const { data, error } = await supabase.rpc('read_vault_secret', { secret_name: 'sync_secret' });
  if (error || typeof data !== 'string' || data.length === 0) return null;
  return data;
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

  const resendKey = Deno.env.get('RESEND_API_KEY')?.trim();
  const fromAddress = Deno.env.get('ALERT_FROM_EMAIL')?.trim() || 'alerts@familybudget.app';
  if (!resendKey) {
    return json({ error: 'not_configured', message: 'RESEND_API_KEY is not set.' }, 503);
  }

  const { data: households, error: hError } = await admin.from('households').select('id');
  if (hError) return json({ error: 'internal', message: hError.message }, 500);

  const results = [];
  for (const household of households ?? []) {
    try {
      const [{ data: billRows, error: billsError }, { data: sentRows }, { data: memberRows }] = await Promise.all([
        admin.from('active_bills').select('*').eq('household_id', household.id),
        admin.from('sent_alerts').select('alert_key').eq('household_id', household.id),
        admin.from('household_members').select('user_id').eq('household_id', household.id),
      ]);
      if (billsError) throw new Error(`could not load bills: ${billsError.message}`);

      const bills = (billRows ?? []).map(rowToBill);
      const dismissed = new Set((sentRows ?? []).map((r: any) => r.alert_key));
      const { toEmail, urgent } = buildAlerts({ bills, dismissed });

      // Push first, and independently of email: a phone in a pocket is the
      // point of an urgent alert, and it must not be skipped because the
      // email provider is misconfigured or the digest happens to be empty.
      const push = await pushToHousehold(admin, household.id, urgent ?? []);

      const email = composeAlertEmail(toEmail);
      if (!email) {
        results.push({ householdId: household.id, sent: 0, ...push });
        continue;
      }

      // Auth Admin API, not a table query — auth.users isn't exposed through
      // PostgREST, and this is the supported server-side way to resolve a
      // user id to the email address they actually signed up with.
      const recipients: string[] = [];
      for (const member of memberRows ?? []) {
        const { data: userResult } = await admin.auth.admin.getUserById(member.user_id);
        if (userResult?.user?.email) recipients.push(userResult.user.email);
      }
      if (!recipients.length) {
        results.push({ householdId: household.id, sent: 0, error: 'no recipient emails on file' });
        continue;
      }

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: fromAddress, to: recipients, subject: email.subject, text: email.body }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Resend ${response.status}: ${body.slice(0, 200)}`);
      }

      // Mark every alert just emailed as sent, so a run with nothing new
      // doesn't repeat the same email tomorrow.
      const { error: upsertError } = await admin.from('sent_alerts').upsert(
        toEmail.map((a: any) => ({ household_id: household.id, alert_key: a.key })),
        { onConflict: 'household_id,alert_key' },
      );
      if (upsertError) throw new Error(`could not record sent alerts: ${upsertError.message}`);

      results.push({
        householdId: household.id, sent: toEmail.length, recipients: recipients.length, ...push,
      });
    } catch (error: any) {
      results.push({ householdId: household.id, error: error.message });
    }
  }

  return json({ results });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
