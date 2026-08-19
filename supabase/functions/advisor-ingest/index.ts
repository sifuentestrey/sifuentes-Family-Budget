/**
 * Receives structured recommendations produced by ChatGPT Finance.
 *
 * This endpoint is intentionally separate from GitHub and from transaction
 * ingestion. It stores recommendations in an idempotent inbox. Replaying the
 * same daily analysis cannot create duplicates because the database enforces
 * (household_id, recommendation_id) uniqueness.
 *
 * Authentication: set ADVISOR_INGEST_SECRET in Supabase secrets and send
 * Authorization: Bearer <same-secret>. The secret is never stored in GitHub.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function sameSecret(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const { data: vaultSecret } = await admin.rpc('read_vault_secret', { secret_name: 'advisor_ingest_secret' });
  const configured = (Deno.env.get('ADVISOR_INGEST_SECRET') ?? vaultSecret)?.trim();
  const presented = req.headers.get('Authorization') ?? '';
  if (!configured || !sameSecret(presented, `Bearer ${configured}`)) {
    return json({ error: 'unauthorized' }, 401);
  }

  try {
    const body = await req.json();
    const householdId = body?.household_id;
    const analysisDate = body?.analysis_date;
    const recommendations = body?.recommendations;

    if (typeof householdId !== 'string' || !householdId) {
      return json({ error: 'bad_request', message: 'household_id is required' }, 400);
    }
    if (typeof analysisDate !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(analysisDate)) {
      return json({ error: 'bad_request', message: 'analysis_date must be YYYY-MM-DD' }, 400);
    }
    if (!Array.isArray(recommendations)) {
      return json({ error: 'bad_request', message: 'recommendations must be an array' }, 400);
    }
    if (recommendations.length > 100) {
      return json({ error: 'bad_request', message: 'maximum 100 recommendations per delivery' }, 400);
    }

    const { data: household, error: householdError } = await admin
      .from('households').select('id').eq('id', householdId).maybeSingle();
    if (householdError) throw householdError;
    if (!household) return json({ error: 'unknown_household' }, 404);

    const valid = recommendations.filter((r: any) =>
      r && typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 180 &&
      typeof r.type === 'string' && typeof r.action === 'string' &&
      ['apply', 'review', 'flag_only', 'no_action', 'already_applied'].includes(r.action) &&
      typeof r.title === 'string' && typeof r.message === 'string'
    );

    const rows = valid.map((r: any) => ({
      household_id: householdId,
      recommendation_id: r.id,
      analysis_date: analysisDate,
      type: r.type,
      action: r.action,
      priority: ['low', 'medium', 'high', 'urgent'].includes(r.priority) ? r.priority : 'medium',
      title: r.title.slice(0, 300),
      message: r.message.slice(0, 4000),
      reason: typeof r.reason === 'string' ? r.reason.slice(0, 4000) : null,
      confidence: typeof r.confidence === 'number' ? r.confidence : null,
      payload: r,
      status: r.action === 'already_applied' ? 'applied' : 'pending',
    }));

    const { data: inserted, error } = rows.length
      ? await admin.from('advisor_recommendations')
          .upsert(rows, { onConflict: 'household_id,recommendation_id', ignoreDuplicates: true })
          .select('id, recommendation_id, status')
      : { data: [], error: null };
    if (error) throw error;

    const received = recommendations.length;
    const accepted = valid.length;
    const duplicates = accepted - (inserted?.length ?? 0);

    return json({
      ok: true,
      analysis_date: analysisDate,
      received,
      accepted,
      inserted: inserted?.length ?? 0,
      duplicates,
      rejected: received - accepted,
      recommendations: inserted ?? [],
    });
  } catch (error: any) {
    return json({ error: 'internal', message: error.message }, 500);
  }
});
