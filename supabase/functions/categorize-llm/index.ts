/**
 * LLM categorization — the fourth layer categorizeBatch (src/engine/
 * categorize.js) was always designed for: "llm — optional, off by default,
 * unknown payees only." That layer never had a caller until this file.
 *
 * Deliberately scoped to the residue, never the whole table: only rows
 * still categorized_by='none' after learned rules, household rules, seed
 * rules, and Plaid's own category all had a turn. A human correction still
 * outranks everything — manually_categorized rows are never touched, and
 * this never overwrites a row categorized_by anything other than 'none'.
 *
 * Uses Gemini rather than Anthropic for this one function specifically —
 * the household asked for whatever could be set up without a paid API
 * account; Gemini's free tier fits, at the cost of being a second model
 * provider in this codebase. Kept to exactly this one function so that if
 * that tradeoff changes later, only this file needs to move.
 *
 * A transaction the model is not confident about is simply left out of its
 * response, not force-fit to a guess — it stays categorized_by='none' and
 * visible in the review queue, same as a keyword-rule miss. The one time a
 * human corrects it, that becomes a permanent learned rule (categorize.js's
 * top-precedence layer), which is a better long-term outcome than the LLM
 * re-guessing the same payee every night.
 *
 * Scheduled the same way sync-transactions/sync-bills are: pg_cron presents
 * a Vault-held bearer token, checked with the same fail-closed constant-time
 * comparison.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const BATCH_SIZE = 60;

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

interface Candidate {
  id: string;
  payee: string;
  amount: number;
  raw_description: string;
}

async function categorizeHousehold(
  admin: SupabaseClient,
  apiKey: string,
  householdId: string,
): Promise<{ categorized: number; skipped: number }> {
  const { data: rows, error: rowsError } = await admin
    .from('transactions')
    .select('id, payee, amount, raw_description')
    .eq('household_id', householdId)
    .eq('categorized_by', 'none')
    .is('category_id', null)
    .eq('manually_categorized', false)
    .eq('is_transfer', false)
    .order('posted_date', { ascending: false })
    .limit(BATCH_SIZE);
  if (rowsError) throw new Error(`could not load candidates: ${rowsError.message}`);
  if (!rows?.length) return { categorized: 0, skipped: 0 };

  const { data: categories, error: catError } = await admin
    .from('categories')
    .select('id, name')
    .eq('household_id', householdId)
    .eq('is_archived', false);
  if (catError) throw new Error(`could not load categories: ${catError.message}`);
  if (!categories?.length) return { categorized: 0, skipped: rows.length };

  const categoryIdByName = new Map(categories.map((c: any) => [c.name, c.id]));
  const candidates: Candidate[] = rows as Candidate[];

  const decisions = await askGemini(apiKey, candidates, [...categoryIdByName.keys()]);

  let categorized = 0;
  for (const decision of decisions) {
    const categoryId = categoryIdByName.get(decision.category);
    // Defensive: never trust the model to only emit names from the list it
    // was given, and never touch an id it was not asked about.
    if (!categoryId || !candidates.some((c) => c.id === decision.id)) continue;

    const { error } = await admin
      .from('transactions')
      .update({ category_id: categoryId, categorized_by: 'llm' })
      .eq('id', decision.id)
      .eq('categorized_by', 'none'); // still uncategorized at write time, not just at read time
    if (!error) categorized++;
  }

  return { categorized, skipped: candidates.length - categorized };
}

async function askGemini(
  apiKey: string,
  candidates: Candidate[],
  categoryNames: string[],
): Promise<{ id: string; category: string }[]> {
  const prompt = [
    'You are categorizing household bank transactions for a budgeting app.',
    `Valid categories (use exactly one of these names, nothing else): ${categoryNames.join(', ')}`,
    '',
    'For each transaction below, pick the single best-fitting category.',
    'Sign convention: positive amount = money out (spending), negative = money in (deposit).',
    'If you are not reasonably confident for a transaction, OMIT it from your response entirely',
    '— do not guess, and do not invent a category name not in the list above.',
    '',
    'Transactions (id, payee, amount, raw bank description):',
    JSON.stringify(candidates.map((c) => ({
      id: c.id, payee: c.payee, amount: c.amount, description: c.raw_description,
    }))),
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
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                id: { type: 'STRING' },
                category: { type: 'STRING' },
              },
              required: ['id', 'category'],
            },
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
  if (!Array.isArray(parsed)) throw new Error('Gemini response was not an array');
  return parsed;
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

  const { data: households, error } = await admin.from('households').select('id');
  if (error) return json({ error: error.message }, 500);

  const results = [];
  for (const h of households ?? []) {
    try {
      results.push({ household_id: h.id, ...(await categorizeHousehold(admin, apiKey, h.id)) });
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
