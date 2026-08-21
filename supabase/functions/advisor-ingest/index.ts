/**
 * Receives structured recommendations produced by ChatGPT Finance.
 *
 * Recommendations are stored idempotently. A recommendation may also include
 * `app_changes`, but only two reversible transaction metadata operations are
 * eligible for automatic application here. Every attempted change is audited
 * in finance_brain_actions. Human/manual categorization always wins.
 */
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const AUTO_APPLY_CONFIDENCE = 0.92;
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

function validChange(change: any) {
  return change &&
    ['set_transaction_transfer', 'set_transaction_category'].includes(change.operation) &&
    typeof change.plaid_transaction_id === 'string' && change.plaid_transaction_id.length > 0 &&
    change.plaid_transaction_id.length <= 300;
}

async function auditAction(
  admin: SupabaseClient,
  row: Record<string, unknown>,
) {
  const { data, error } = await admin.from('finance_brain_actions')
    .upsert(row, { onConflict: 'household_id,recommendation_id,action_index', ignoreDuplicates: true })
    .select('id,status')
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function applyChange(
  admin: SupabaseClient,
  householdId: string,
  recommendation: any,
  change: any,
  index: number,
) {
  const confidence = typeof change.confidence === 'number'
    ? change.confidence
    : (typeof recommendation.confidence === 'number' ? recommendation.confidence : null);
  const base = {
    household_id: householdId,
    recommendation_id: recommendation.id,
    action_index: index,
    operation: change.operation,
    target_key: change.plaid_transaction_id,
    proposed: change,
    confidence,
    reason: typeof change.reason === 'string' ? change.reason.slice(0, 4000) : null,
  };

  const { data: existing } = await admin.from('finance_brain_actions')
    .select('id,status')
    .eq('household_id', householdId)
    .eq('recommendation_id', recommendation.id)
    .eq('action_index', index)
    .maybeSingle();
  if (existing) return { operation: change.operation, status: existing.status, duplicate: true };

  if (recommendation.action !== 'apply' || confidence == null || confidence < AUTO_APPLY_CONFIDENCE) {
    await auditAction(admin, { ...base, status: 'review' });
    return { operation: change.operation, status: 'review' };
  }

  const { data: tx, error: txError } = await admin.from('transactions')
    .select('id,plaid_transaction_id,category_id,categorized_by,manually_categorized,is_transfer,transfer_pair_id,is_income')
    .eq('household_id', householdId)
    .eq('plaid_transaction_id', change.plaid_transaction_id)
    .maybeSingle();
  if (txError) throw txError;
  if (!tx) {
    await auditAction(admin, { ...base, status: 'failed', error: 'transaction_not_found' });
    return { operation: change.operation, status: 'failed', error: 'transaction_not_found' };
  }

  if (change.operation === 'set_transaction_transfer') {
    // Only auto-promote a transaction to transfer. Unmarking a transfer can break
    // a valid pair and therefore always goes to review.
    if (change.is_transfer !== true) {
      await auditAction(admin, { ...base, status: 'review', before_state: tx });
      return { operation: change.operation, status: 'review' };
    }

    const after = { is_transfer: true, is_income: false };
    const { error } = await admin.from('transactions')
      .update({ ...after, updated_at: new Date().toISOString() })
      .eq('id', tx.id)
      .eq('household_id', householdId);
    if (error) {
      await auditAction(admin, { ...base, status: 'failed', before_state: tx, error: error.message.slice(0, 1000) });
      return { operation: change.operation, status: 'failed' };
    }
    await auditAction(admin, { ...base, status: 'applied', before_state: tx, after_state: after, applied_at: new Date().toISOString() });
    return { operation: change.operation, status: 'applied' };
  }

  // Category changes never override a person's explicit correction.
  if (tx.manually_categorized) {
    await auditAction(admin, { ...base, status: 'review', before_state: tx, error: 'manual_category_protected' });
    return { operation: change.operation, status: 'review' };
  }
  if (typeof change.category_name !== 'string' || !change.category_name.trim()) {
    await auditAction(admin, { ...base, status: 'rejected', before_state: tx, error: 'category_name_required' });
    return { operation: change.operation, status: 'rejected' };
  }

  const { data: category, error: categoryError } = await admin.from('categories')
    .select('id,name')
    .eq('household_id', householdId)
    .ilike('name', change.category_name.trim())
    .eq('is_archived', false)
    .limit(1)
    .maybeSingle();
  if (categoryError) throw categoryError;
  if (!category) {
    await auditAction(admin, { ...base, status: 'review', before_state: tx, error: 'category_not_found' });
    return { operation: change.operation, status: 'review' };
  }

  const after = { category_id: category.id, categorized_by: 'finance' };
  const { error } = await admin.from('transactions')
    .update({ ...after, updated_at: new Date().toISOString() })
    .eq('id', tx.id)
    .eq('household_id', householdId)
    .eq('manually_categorized', false);
  if (error) {
    await auditAction(admin, { ...base, status: 'failed', before_state: tx, error: error.message.slice(0, 1000) });
    return { operation: change.operation, status: 'failed' };
  }
  await auditAction(admin, { ...base, status: 'applied', before_state: tx, after_state: { ...after, category_name: category.name }, applied_at: new Date().toISOString() });
  return { operation: change.operation, status: 'applied' };
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
    if (typeof analysisDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(analysisDate)) {
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
          .select('id,recommendation_id,status')
      : { data: [], error: null };
    if (error) throw error;

    const appliedChanges: any[] = [];
    for (const recommendation of valid) {
      const changes = Array.isArray(recommendation.app_changes)
        ? recommendation.app_changes.filter(validChange).slice(0, 20)
        : [];
      for (let i = 0; i < changes.length; i++) {
        appliedChanges.push({
          recommendation_id: recommendation.id,
          ...(await applyChange(admin, householdId, recommendation, changes[i], i)),
        });
      }

      const outcomes = appliedChanges.filter((x) => x.recommendation_id === recommendation.id);
      if (outcomes.length && outcomes.every((x) => x.status === 'applied' || x.duplicate)) {
        await admin.from('advisor_recommendations')
          .update({ status: 'applied', applied_at: new Date().toISOString() })
          .eq('household_id', householdId)
          .eq('recommendation_id', recommendation.id);
      }
    }

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
      app_changes: appliedChanges,
    });
  } catch (error: any) {
    return json({ error: 'internal', message: error.message }, 500);
  }
});
