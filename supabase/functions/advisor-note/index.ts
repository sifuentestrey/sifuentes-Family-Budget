/**
 * Soft financial advisor.
 *
 * Deliberately does not compute a single dollar figure itself. The browser
 * sends a summary built from the same engine functions (src/engine/*) that
 * already power the dashboard — buildExpensePicture, reliableMonthlyIncome,
 * floorCoverage, analyzeSubscriptions, calculateSafeToSpend — so every
 * number the model sees already passed through this app's one tested
 * definition of what it means. This function's only job is turning correct
 * numbers into a short, specific, human note. It cannot hallucinate a
 * dollar amount that matters because it never computes one — at most it
 * mischaracterizes a real number, which is a much smaller failure mode than
 * inventing one.
 *
 * Sends only the aggregate summary, never the raw transaction list — the
 * household's actual purchase history has no reason to leave this system
 * for something a narrative paragraph does not need.
 *
 * Kept as a household-visible history (advisor_notes) rather than a
 * stateless one-shot: the last few notes ride along in the prompt so a new
 * note has continuity instead of repeating the same observation every time
 * it is asked.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const HISTORY_LIMIT = 3;

const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const apiKey = Deno.env.get('GEMINI_API_KEY')?.trim();
  if (!apiKey) {
    return json({ error: 'not_configured', message: 'GEMINI_API_KEY is not set.' }, 503);
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

    const { summary } = await req.json();
    if (!summary || typeof summary !== 'object') {
      return json({ error: 'bad_request', message: 'summary is required' }, 400);
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: history } = await admin
      .from('advisor_notes')
      .select('note, created_at')
      .eq('household_id', membership.household_id)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT);

    const note = await askGemini(apiKey, summary, history ?? []);

    const { data: saved, error: saveError } = await admin
      .from('advisor_notes')
      .insert({ household_id: membership.household_id, note })
      .select('id, note, created_at')
      .single();
    if (saveError) throw new Error(`could not save note: ${saveError.message}`);

    return json(saved);
  } catch (error: any) {
    return json({ error: 'internal', message: error.message }, 500);
  }
});

async function askGemini(
  apiKey: string,
  summary: Record<string, unknown>,
  history: { note: string; created_at: string }[],
): Promise<string> {
  const prompt = [
    'You are a calm, specific household financial advisor speaking directly to a couple.',
    'You are given a JSON summary of their actual current finances, already computed correctly',
    '— never invent, adjust, or recompute a number that is not present in this JSON.',
    '',
    'Write 3 to 5 sentences of plain, direct commentary a thoughtful friend who is good with money',
    'would say after seeing these numbers. Be specific — reference actual figures and category names',
    'from the data. Prioritize the single most useful thing to notice, not a checklist of everything.',
    'No disclaimers, no "consult a financial professional", no generic encouragement with no content.',
    'If nothing notable stands out, say that plainly rather than manufacturing concern.',
    'Write dollar amounts as normal currency ($2,350, $346.39) — never spelled out in words',
    '("two thousand three hundred fifty dollars"), which reads as robotic, not like a person talking.',
    '',
    history.length ? [
      'Your last few check-ins with this household, most recent first — do not repeat the same',
      'observation unless the underlying number has materially changed:',
      ...history.map((h, i) => `${i + 1}. (${h.created_at.slice(0, 10)}) ${h.note}`),
      '',
    ].join('\n') : '',
    'Current financial summary:',
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
