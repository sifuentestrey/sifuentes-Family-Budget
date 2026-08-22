import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const PROVIDER_KIND = { bills: 'bills', payroll: 'payroll', paystubs: 'payroll' };
const BILL_STATUS = new Set(['detected', 'confirmed', 'scheduled', 'paid', 'overdue', 'disputed', 'ignored']);
const now = () => new Date().toISOString();
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const text = (v, n, fallback = null) => typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : fallback;
const number = (v, min = 0, max = 1_000_000, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : fallback;
};
const optionalNumber = (v, min = 0, max = 1_000_000) => v === null || v === undefined || v === '' ? null : (() => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : null;
})();
const time = (v) => {
  const value = text(v, 8);
  if (!value) return null;
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return `${value}:00`;
  return /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value) ? value : null;
};
const same = (a, b) => Math.abs(Number(a ?? 0) - Number(b ?? 0)) < 0.005;
const obj = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : {};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function constantTimeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function configuredSecret(db) {
  const env = Deno.env.get('HERMES_INGEST_SECRET')?.trim();
  if (env) return env;
  const { data, error } = await db.rpc('read_vault_secret', { secret_name: 'hermes_ingest_secret' });
  return error || typeof data !== 'string' ? null : data.trim();
}
async function payProfile(db, householdId, requested) {
  if (requested) {
    const { data, error } = await db.from('pay_profiles').select('id').eq('id', requested)
      .eq('household_id', householdId).eq('is_active', true).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('pay_profile_id is not an active profile for this household');
    return data.id;
  }
  const { data, error } = await db.from('pay_profiles').select('id').eq('household_id', householdId)
    .eq('is_active', true).limit(2);
  if (error) throw error;
  if (data?.length !== 1) throw new Error('pay_profile_id is required when zero or multiple active pay profiles exist');
  return data[0].id;
}
async function payPeriod(db, householdId, profileId, c) {
  if (!isDate(c?.period_start)) return null;
  if (![c?.period_end, c?.pay_date].every(isDate)) {
    const { data, error } = await db.from('pay_periods').select('id')
      .eq('household_id', householdId).eq('pay_profile_id', profileId)
      .eq('period_start', c.period_start).maybeSingle();
    if (error) throw error;
    return data?.id ?? null;
  }
  const { data, error } = await db.from('pay_periods').upsert({
    household_id: householdId, pay_profile_id: profileId, period_start: c.period_start,
    period_end: c.period_end, pay_date: c.pay_date,
    status: ['open', 'submitted', 'paid'].includes(c.period_status) ? c.period_status : 'open',
  }, { onConflict: 'pay_profile_id,period_start' }).select('id').single();
  if (error) throw error;
  return data.id;
}
async function connection(db, householdId, providerKey, providerName, kind) {
  const stamp = now();
  const { data, error } = await db.from('provider_connections').upsert({
    household_id: householdId, provider_key: providerKey, external_account_id: '', display_name: providerName,
    kind: PROVIDER_KIND[kind], is_live: true, status: 'connected', status_detail: 'Hermes persistent-browser sync',
    connected_at: stamp, last_synced_at: stamp, updated_at: stamp,
  }, { onConflict: 'household_id,provider_key,external_account_id' }).select('id').single();
  if (error) throw error;
  return data.id;
}

async function bills(db, e, runId, s) {
  for (const r of e.records) {
    s.found++;
    const externalId = text(r?.external_id, 180);
    const amount = optionalNumber(r?.amount_due);
    if (!externalId || amount === null || !isDate(r?.due_date)) {
      s.skipped++; s.errors.push({ external_id: externalId, error: 'bill requires external_id, amount_due, due_date' }); continue;
    }
    const row = {
      household_id: e.householdId, provider_name: text(r.provider_name, 160, e.providerName),
      provider_key: text(r.provider_key, 80, e.providerKey), category: text(r.category, 80, 'Other'),
      account_label: text(r.account_label, 8), amount_due: amount, currency: text(r.currency, 3, 'USD').toUpperCase(),
      due_date: r.due_date, statement_date: isDate(r.statement_date) ? r.statement_date : null,
      statement_period_start: isDate(r.statement_period_start) ? r.statement_period_start : null,
      statement_period_end: isDate(r.statement_period_end) ? r.statement_period_end : null,
      status: BILL_STATUS.has(r.status) ? r.status : 'detected', source: 'provider_portal', source_message_id: externalId,
      confidence: number(r.confidence, 0, 1, 0.95), needs_review: r.needs_review === true || number(r.confidence, 0, 1, 0.95) < 0.7,
      raw: { hermes_external_id: externalId, observed_at: e.observedAt }, updated_at: now(),
    };
    let q = await db.from('bills').select('id,provider_name,provider_key,amount_due,due_date,status,statement_date,account_label,confidence,needs_review')
      .eq('household_id', e.householdId).eq('source', 'provider_portal').eq('source_message_id', externalId).maybeSingle();
    if (q.error) throw q.error;
    let existing = q.data;
    if (!existing) {
      q = await db.from('bills').select('id,provider_name,provider_key,amount_due,due_date,status,statement_date,account_label,confidence,needs_review')
        .eq('household_id', e.householdId).eq('provider_key', row.provider_key).eq('due_date', row.due_date).eq('amount_due', row.amount_due).maybeSingle();
      if (q.error) throw q.error; existing = q.data;
    }
    let billId = existing?.id ?? null;
    let outcome = 'created';
    if (existing) {
      const unchanged = existing.provider_name === row.provider_name && existing.provider_key === row.provider_key &&
        same(existing.amount_due, row.amount_due) && existing.due_date === row.due_date && existing.status === row.status &&
        (existing.statement_date ?? null) === row.statement_date && (existing.account_label ?? null) === row.account_label &&
        same(existing.confidence, row.confidence) && Boolean(existing.needs_review) === row.needs_review;
      if (unchanged) { s.duplicates++; outcome = 'duplicate'; }
      else { const { error } = await db.from('bills').update(row).eq('id', billId); if (error) throw error; s.updated++; outcome = row.needs_review ? 'needs_review' : 'updated'; }
    } else {
      const ins = await db.from('bills').insert(row).select('id').single();
      if (ins.error?.code === '23505') { s.duplicates++; outcome = 'duplicate'; }
      else if (ins.error) throw ins.error;
      else { billId = ins.data.id; s.created++; if (row.needs_review) outcome = 'needs_review'; }
    }
    const { error } = await db.from('bill_imports').insert({ household_id: e.householdId, sync_run_id: runId, bill_id: billId,
      source: 'provider_portal', source_ref: externalId, outcome, reason: outcome === 'duplicate' ? 'same Hermes source/identity already present' : null,
      parsed_fields: { provider_key: row.provider_key, amount_due: row.amount_due, due_date: row.due_date }, confidence: row.confidence });
    if (error) throw error;
  }
}

async function payroll(db, e, profileId, periodId, s) {
  for (const r of e.records) {
    s.found++;
    const externalId = text(r?.external_id, 180);
    if (!externalId || !isDate(r?.entry_date)) { s.skipped++; s.errors.push({ external_id: externalId, error: 'time entry requires external_id, entry_date' }); continue; }
    const row = {
      household_id: e.householdId, pay_profile_id: profileId, pay_period_id: periodId, entry_date: r.entry_date,
      start_time: time(r.start_time), end_time: time(r.end_time), regular_hours: number(r.regular_hours, 0, 24),
      overtime_hours: number(r.overtime_hours, 0, 24), standby_hours: number(r.standby_hours, 0, 168),
      callback_hours: number(r.callback_hours, 0, 24), callback_events: Math.max(0, Math.min(20, Math.trunc(Number(r.callback_events ?? 0)) || 0)),
      holiday_hours: number(r.holiday_hours, 0, 24), pto_hours: number(r.pto_hours, 0, 24),
      differential_code: text(r.differential_code, 80), differential_hours: number(r.differential_hours, 0, 24),
      notes: 'Hermes UKG/browser import', source: 'timecard_import', source_ref: externalId, updated_at: now(),
    };
    if (row.regular_hours + row.overtime_hours + row.callback_hours + row.holiday_hours + row.pto_hours > 24.001) {
      s.skipped++; s.errors.push({ external_id: externalId, error: 'worked hours exceed 24 for one day' }); continue;
    }
    const q = await db.from('time_entries').select('id,pay_period_id,start_time,end_time,regular_hours,overtime_hours,standby_hours,callback_hours,callback_events,holiday_hours,pto_hours,differential_code,differential_hours,source_ref')
      .eq('pay_profile_id', profileId).eq('entry_date', row.entry_date).maybeSingle();
    if (q.error) throw q.error;
    if (!q.data) { const { error } = await db.from('time_entries').insert(row); if (error) throw error; s.created++; continue; }
    if (!row.pay_period_id) row.pay_period_id = q.data.pay_period_id ?? null;
    const x = q.data;
    const unchanged = (x.pay_period_id ?? null) === (row.pay_period_id ?? null) && (x.start_time ?? null) === row.start_time &&
      (x.end_time ?? null) === row.end_time && same(x.regular_hours, row.regular_hours) && same(x.overtime_hours, row.overtime_hours) &&
      same(x.standby_hours, row.standby_hours) && same(x.callback_hours, row.callback_hours) && Number(x.callback_events ?? 0) === row.callback_events &&
      same(x.holiday_hours, row.holiday_hours) && same(x.pto_hours, row.pto_hours) && (x.differential_code ?? null) === row.differential_code &&
      same(x.differential_hours, row.differential_hours) && (x.source_ref ?? null) === row.source_ref;
    if (unchanged) s.duplicates++;
    else { const { error } = await db.from('time_entries').update(row).eq('id', x.id); if (error) throw error; s.updated++; }
  }
}

async function paystubs(db, e, profileId, contextPeriodId, s) {
  for (const r of e.records) {
    s.found++;
    const externalId = text(r?.external_id, 180), gross = optionalNumber(r?.gross_pay), net = optionalNumber(r?.net_pay);
    if (!externalId || ![r?.pay_date, r?.period_start, r?.period_end].every(isDate) || gross === null || net === null) {
      s.skipped++; s.errors.push({ external_id: externalId, error: 'paystub requires external_id, dates, gross_pay, net_pay' }); continue;
    }
    if (net > gross) { s.skipped++; s.errors.push({ external_id: externalId, error: 'net_pay cannot exceed gross_pay' }); continue; }
    const periodId = contextPeriodId || await payPeriod(db, e.householdId, profileId, { period_start: r.period_start, period_end: r.period_end, pay_date: r.pay_date, period_status: 'paid' });
    const row = { household_id: e.householdId, pay_profile_id: profileId, pay_period_id: periodId, pay_date: r.pay_date,
      period_start: r.period_start, period_end: r.period_end, gross_pay: gross, net_pay: net, total_taxes: number(r.total_taxes),
      regular_hours: optionalNumber(r.regular_hours, 0, 500), overtime_hours: optionalNumber(r.overtime_hours, 0, 500),
      earnings: obj(r.earnings), source: 'provider_api', source_ref: externalId, confidence: number(r.confidence, 0, 1, 0.98) };
    let q = await db.from('paystubs').select('id,pay_period_id,pay_date,period_start,period_end,gross_pay,net_pay,total_taxes,regular_hours,overtime_hours,earnings,confidence')
      .eq('household_id', e.householdId).eq('source_ref', externalId).maybeSingle();
    if (q.error) throw q.error;
    let existing = q.data;
    if (!existing) { q = await db.from('paystubs').select('id,pay_period_id,pay_date,period_start,period_end,gross_pay,net_pay,total_taxes,regular_hours,overtime_hours,earnings,confidence')
      .eq('household_id', e.householdId).eq('pay_profile_id', profileId).eq('pay_date', row.pay_date).eq('period_start', row.period_start).maybeSingle();
      if (q.error) throw q.error; existing = q.data; }
    let stubId;
    if (!existing) { const ins = await db.from('paystubs').insert(row).select('id').single(); if (ins.error) throw ins.error; stubId = ins.data.id; s.created++; }
    else {
      stubId = existing.id; if (!row.pay_period_id) row.pay_period_id = existing.pay_period_id ?? null;
      const unchanged = (existing.pay_period_id ?? null) === (row.pay_period_id ?? null) && existing.pay_date === row.pay_date &&
        existing.period_start === row.period_start && existing.period_end === row.period_end && same(existing.gross_pay, row.gross_pay) &&
        same(existing.net_pay, row.net_pay) && same(existing.total_taxes, row.total_taxes) && same(existing.regular_hours, row.regular_hours) &&
        same(existing.overtime_hours, row.overtime_hours) && JSON.stringify(existing.earnings ?? {}) === JSON.stringify(row.earnings ?? {}) && same(existing.confidence, row.confidence);
      if (unchanged) s.duplicates++; else { const { error } = await db.from('paystubs').update(row).eq('id', stubId); if (error) throw error; s.updated++; }
    }
    if (Array.isArray(r.deductions)) {
      let x = await db.from('deductions').delete().eq('paystub_id', stubId); if (x.error) throw x.error;
      const deductions = r.deductions.slice(0, 100).map((d) => ({ household_id: e.householdId, paystub_id: stubId,
        label: text(d?.label, 160, 'Deduction'), amount: number(d?.amount), pre_tax: d?.pre_tax === true, category: text(d?.category, 80) }));
      if (deductions.length) { x = await db.from('deductions').insert(deductions); if (x.error) throw x.error; }
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return response({ error: 'method_not_allowed' }, 405);
  if (Number(req.headers.get('content-length') ?? 0) > 512_000) return response({ error: 'payload_too_large' }, 413);
  const db = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const secret = await configuredSecret(db), presented = req.headers.get('Authorization') ?? '';
  if (!secret || !constantTimeEqual(presented, `Bearer ${secret}`)) return response({ error: 'unauthorized' }, 401);

  let runId = null; const started = Date.now();
  try {
    const body = await req.json(), householdId = body?.household_id, providerKey = text(body?.provider_key, 80),
      providerName = text(body?.provider_name, 160), kind = body?.kind, records = body?.records, context = obj(body?.context),
      observedAt = typeof body?.observed_at === 'string' && !Number.isNaN(Date.parse(body.observed_at)) ? new Date(body.observed_at).toISOString() : now();
    if (typeof householdId !== 'string' || !/^[0-9a-f-]{36}$/i.test(householdId)) return response({ error: 'bad_request', message: 'household_id must be a UUID' }, 400);
    if (!providerKey || !/^[a-z0-9][a-z0-9:_-]{2,79}$/i.test(providerKey)) return response({ error: 'bad_request', message: 'invalid provider_key' }, 400);
    if (!providerName || !Object.hasOwn(PROVIDER_KIND, kind) || !Array.isArray(records) || records.length > 250) return response({ error: 'bad_request', message: 'invalid provider_name, kind, or records' }, 400);
    const h = await db.from('households').select('id').eq('id', householdId).maybeSingle(); if (h.error) throw h.error; if (!h.data) return response({ error: 'unknown_household' }, 404);
    const connectionId = await connection(db, householdId, providerKey, providerName, kind);
    const run = await db.from('sync_runs').insert({ household_id: householdId, connection_id: connectionId, provider_key: providerKey,
      kind, status: 'running', provider_is_live: true }).select('id').single(); if (run.error) throw run.error; runId = run.data.id;
    const stats = { found: 0, created: 0, updated: 0, skipped: 0, duplicates: 0, errors: [] };
    const envelope = { householdId, providerKey, providerName, records, observedAt };
    if (kind === 'bills') await bills(db, envelope, runId, stats);
    else { const profileId = await payProfile(db, householdId, context.pay_profile_id), periodId = await payPeriod(db, householdId, profileId, context);
      if (kind === 'payroll') await payroll(db, envelope, profileId, periodId, stats); else await paystubs(db, envelope, profileId, periodId, stats); }
    const status = stats.errors.length ? 'partial' : 'success';
    let x = await db.from('sync_runs').update({ completed_at: now(), status, items_found: stats.found, items_created: stats.created,
      items_updated: stats.updated, items_skipped: stats.skipped, duplicates_detected: stats.duplicates, errors: stats.errors.slice(0, 50), duration_ms: Date.now() - started }).eq('id', runId);
    if (x.error) throw x.error;
    x = await db.from('provider_connections').update({ status: status === 'success' ? 'connected' : 'error',
      status_detail: status === 'success' ? `Hermes ${kind} sync successful` : `Hermes ${kind} sync completed with validation errors`, last_synced_at: now(), updated_at: now() }).eq('id', connectionId);
    if (x.error) throw x.error;
    return response({ ok: true, kind, provider_key: providerKey, sync_run_id: runId, status, stats });
  } catch (error) {
    if (runId) try { await db.from('sync_runs').update({ completed_at: now(), status: 'error', errors: [{ error: error?.message ?? String(error) }], duration_ms: Date.now() - started }).eq('id', runId); } catch { /* audit best effort */ }
    return response({ error: 'internal', message: error?.message ?? String(error) }, 500);
  }
});
