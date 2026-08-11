/**
 * AI-assisted manual bill entry.
 *
 * sync-bills already parses Gmail automatically; this is the same idea for
 * the bill a household types or pastes in themselves — a screenshot's text,
 * a portal page copied over, a provider that will never have an email or PDF
 * to scan. Given raw pasted text, extracts the fields the "Add a bill" form
 * needs so the household edits/confirms numbers instead of typing every
 * field from a blank form.
 *
 * Extraction only — this never writes to the bills table itself. The
 * household reviews and saves from the client, same as a low-confidence
 * Gmail parse already requires a human look before it counts toward what's
 * due (see bills.confirmBill).
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const MAX_TEXT_LENGTH = 4000;

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

    const { text } = await req.json();
    if (!text || typeof text !== 'string' || !text.trim()) {
      return json({ error: 'bad_request', message: 'text is required' }, 400);
    }

    const extracted = await askGemini(apiKey, text.trim().slice(0, MAX_TEXT_LENGTH));
    return json(extracted);
  } catch (error: any) {
    return json({ error: 'internal', message: error.message }, 500);
  }
});

async function askGemini(apiKey: string, text: string) {
  const prompt = [
    'Extract bill details from the pasted text below — an email body, a portal page,',
    'or a screenshot transcript of a bill. The household will review every field before',
    'saving, so it is fine to leave a field null if it is genuinely not present in the text',
    '— never guess a number or date that is not actually there.',
    '',
    'providerName: who is being paid (e.g. "Con Edison", "Chase Sapphire", "Planet Fitness").',
    'amountDue: the total amount owed, as a plain number, no currency symbol.',
    'dueDate: the payment due date in YYYY-MM-DD. If a year is not stated, infer the nearest',
    `  future occurrence of the given month/day relative to today, ${new Date().toISOString().slice(0, 10)}.`,
    'category: your best single-word-or-two guess at a household budget category',
    '  (e.g. "Utilities", "Subscriptions", "Car Insurance", "Internet/Phone") — a plain guess,',
    '  not from a fixed list.',
    'confidence: 0 to 1, how confident you are in amountDue and dueDate specifically.',
    '',
    'Pasted text:',
    text,
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
            properties: {
              providerName: { type: 'STRING', nullable: true },
              amountDue: { type: 'NUMBER', nullable: true },
              dueDate: { type: 'STRING', nullable: true },
              category: { type: 'STRING', nullable: true },
              confidence: { type: 'NUMBER' },
            },
            required: ['confidence'],
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
  const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!responseText) throw new Error('Gemini returned no content');

  return JSON.parse(responseText);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
