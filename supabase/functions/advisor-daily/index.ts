/**
 * Daily automated check-in.
 *
 * advisor-note (the on-demand button) is user-triggered and computes its
 * summary from live browser state, because a real person is looking at the
 * screen when it runs. This function has no browser and no user request to
 * ride along with — it runs on pg_cron, once a night, for every household —
 * so it derives the same summary shape (buildDailySummary, src/engine/
 * advisor-summary.js) straight from the household's Postgres rows instead.
 * Using the identical pure function the dashboard's own advisor button feeds
 * is the whole point: the nightly note and the on-demand note can disagree
 * in what they choose to say, never in what the numbers actually are.
 *
 * Writes to the same advisor_notes table as advisor-note, tagged
 * source='daily' so a) the "don't repeat the last observation" prompt
 * context can tell which past notes were unprompted, and b) a household that
 * already got today's note doesn't get a second one if the cron is ever
 * retried.
 *
 * Emails the note via Resend, reusing the exact pattern send-alerts already
 * established (recipient resolution via the Auth Admin API, same env vars) —
 * a check-in nobody opens the app to read is not a check-in.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { buildDailySummary } from '../_shared/advisor-summary.js';
import { rowToBill } from '../_shared/ingestion/bill-row-mapping.js';

const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const HISTORY_LIMIT = 3;
const TRANSACTION_WINDOW_DAYS = 150;

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

async function loadTransactions(admin: SupabaseClient, householdId: string) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - TRANSACTION_WINDOW_DAYS);

  const { data: rows, error } = await admin
    .from('transactions')
    .select('*, categories(name)')
    .eq('household_id', householdId)
    .gte('posted_date', since.toISOString().slice(0, 10));
  if (error) throw new Error(`could not load transactions: ${error.message}`);

  return (rows ?? []).map((r: any) => ({
    ...r,
    amount: Number(r.amount),
    category: r.categories?.name ?? null,
  }));
}

async function alreadySentToday(admin: SupabaseClient, householdId: string): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await admin
    .from('advisor_notes')
    .select('id')
    .eq('household_id', householdId)
    .eq('source', 'daily')
    .gte('created_at', `${today}T00:00:00Z`)
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}

async function checkInForHousehold(admin: SupabaseClient, apiKey: string, resendKey: string | undefined, fromAddress: string, householdId: string) {
  if (await alreadySentToday(admin, householdId)) {
    return { sent: false, reason: 'already sent today' };
  }

  const [transactions, { data: billRows }, { data: history }, { data: members }] = await Promise.all([
    loadTransactions(admin, householdId),
    admin.from('active_bills').select('*').eq('household_id', householdId),
    admin.from('advisor_notes').select('note, created_at').eq('household_id', householdId)
      .order('created_at', { ascending: false }).limit(HISTORY_LIMIT),
    admin.from('household_members').select('user_id').eq('household_id', householdId),
  ]);

  const bills = (billRows ?? []).map(rowToBill);
  const summary = buildDailySummary({ transactions, bills });

  const note = await askGemini(apiKey, summary, history ?? []);

  const { data: saved, error: saveError } = await admin
    .from('advisor_notes')
    .insert({ household_id: householdId, note, source: 'daily' })
    .select('id')
    .single();
  if (saveError) throw new Error(`could not save note: ${saveError.message}`);

  if (!resendKey) return { sent: true, note_id: saved.id, emailed: false, reason: 'RESEND_API_KEY not set' };

  const recipients: string[] = [];
  for (const member of members ?? []) {
    const { data: userResult } = await admin.auth.admin.getUserById(member.user_id);
    if (userResult?.user?.email) recipients.push(userResult.user.email);
  }
  if (!recipients.length) return { sent: true, note_id: saved.id, emailed: false, reason: 'no recipient emails on file' };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromAddress,
      to: recipients,
      subject: "Today's check-in",
      text: note,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { sent: true, note_id: saved.id, emailed: false, reason: `Resend ${response.status}: ${body.slice(0, 200)}` };
  }

  return { sent: true, note_id: saved.id, emailed: true, recipients: recipients.length };
}

async function askGemini(
  apiKey: string,
  summary: Record<string, unknown>,
  history: { note: string; created_at: string }[],
): Promise<string> {
  const prompt = [
    'You are a calm, specific household financial advisor writing an unprompted daily check-in',
    '(the household did not ask a question — this arrives automatically, so it must earn being read).',
    'You are given a JSON summary of their actual current finances, already computed correctly',
    '— never invent, adjust, or recompute a number that is not present in this JSON.',
    '',
    'Write 2 to 4 sentences of plain, direct commentary a thoughtful friend who is good with money',
    'would say after seeing these numbers today. Be specific — reference actual figures and category',
    'names from the data. Prioritize the single most useful thing to notice, not a checklist.',
    'No disclaimers, no "consult a financial professional", no generic encouragement with no content.',
    'If nothing notable stands out today, say that plainly and briefly rather than manufacturing',
    'concern — a quiet day is a fine thing for a daily check-in to report.',
    'Write dollar amounts as normal currency ($2,350, $346.39) — never spelled out in words.',
    '',
    history.length ? [
      'Your last few check-ins with this household, most recent first — do not repeat the same',
      'observation unless the underlying number has materially changed:',
      ...history.map((h, i) => `${i + 1}. (${h.created_at.slice(0, 10)}) ${h.note}`),
      '',
    ].join('\n') : '',
    "Today's financial summary:",
    JSON.stringify(summary),
  ].join('\n');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          response_mime_type: 'application/json',
          response_schema: {
            type: 'OBJECT',
            properties: { note: { type: 'STRING' } },
            required: ['note'],
          },
        },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Gemini API ${response.status}: ${body.slice(0, 300)}`);
  }

  const result = await response.json();
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no content');

  const parsed = JSON.parse(text);
  if (typeof parsed.note !== 'string' || !parsed.note.trim()) {
    throw new Error('Gemini returned an empty note');
  }
  return parsed.note.trim();
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

  const apiKey = Deno.env.get('GEMINI_API_KEY')?.trim();
  if (!apiKey) {
    return json({ error: 'not_configured', message: 'GEMINI_API_KEY is not set.' }, 503);
  }
  const resendKey = Deno.env.get('RESEND_API_KEY')?.trim();
  const fromAddress = Deno.env.get('ALERT_FROM_EMAIL')?.trim() || 'alerts@familybudget.app';

  const { data: households, error } = await admin.from('households').select('id');
  if (error) return json({ error: error.message }, 500);

  const results = [];
  for (const h of households ?? []) {
    try {
      results.push({ household_id: h.id, ...(await checkInForHousehold(admin, apiKey, resendKey, fromAddress, h.id)) });
    } catch (e: any) {
      results.push({ household_id: h.id, error: e.message });
    }
  }

  return json({ results });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
