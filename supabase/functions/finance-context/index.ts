/**
 * Compact app-only context for ChatGPT Finances.
 *
 * Finances already owns connected-account data (transactions, balances,
 * recurring activity, liabilities, investments). This endpoint deliberately
 * excludes that data and returns only facts the Family Budget app knows that
 * Finances cannot obtain directly: verified bills, payroll/timecard state,
 * and the latest paycheck forecast/paystub context.
 *
 * Authentication uses the same dedicated advisor secret as advisor-ingest.
 * The secret may be supplied by env or Vault and is never stored in GitHub.
 */
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

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

async function configuredSecret(admin: SupabaseClient): Promise<string | null> {
  const fromEnv = Deno.env.get('ADVISOR_INGEST_SECRET')?.trim();
  if (fromEnv) return fromEnv;
  const { data } = await admin.rpc('read_vault_secret', { secret_name: 'advisor_ingest_secret' });
  return typeof data === 'string' && data.trim() ? data.trim() : null;
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}

async function resolveHousehold(admin: SupabaseClient, requested: unknown): Promise<string> {
  if (typeof requested === 'string' && requested) {
    const { data, error } = await admin.from('households').select('id').eq('id', requested).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('unknown_household');
    return requested;
  }

  const { data, error } = await admin.from('households').select('id').limit(2);
  if (error) throw error;
  if ((data ?? []).length !== 1) throw new Error('household_id_required');
  return data![0].id;
}

async function loadPayrollContext(admin: SupabaseClient, householdId: string) {
  const { data: profile, error: profileError } = await admin
    .from('pay_profiles')
    .select('id, label, employer_name, base_hourly_rate, overtime_multiplier, double_time_multiplier, standby_rate, standby_is_daily, callback_minimum_hours, callback_multiplier, holiday_multiplier, differential_rates, recurring_deductions, pay_frequency, is_active')
    .eq('household_id', householdId)
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile) return { profile: null, current_period: null, latest_paystub: null };

  const { data: period, error: periodError } = await admin
    .from('pay_periods')
    .select('id, period_start, period_end, pay_date, status')
    .eq('household_id', householdId)
    .eq('pay_profile_id', profile.id)
    .eq('status', 'open')
    .order('pay_date', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (periodError) throw periodError;

  let hours = null;
  let forecast = null;
  if (period) {
    const { data: entries, error: entriesError } = await admin
      .from('time_entries')
      .select('entry_date, regular_hours, overtime_hours, standby_hours, callback_hours, callback_events, holiday_hours, pto_hours, differential_code, differential_hours, source')
      .eq('household_id', householdId)
      .eq('pay_period_id', period.id)
      .order('entry_date', { ascending: true });
    if (entriesError) throw entriesError;

    const totals = (entries ?? []).reduce((acc: any, e: any) => {
      acc.regular += Number(e.regular_hours ?? 0);
      acc.overtime += Number(e.overtime_hours ?? 0);
      acc.standby += Number(e.standby_hours ?? 0);
      acc.callback += Number(e.callback_hours ?? 0);
      acc.callback_events += Number(e.callback_events ?? 0);
      acc.holiday += Number(e.holiday_hours ?? 0);
      acc.pto += Number(e.pto_hours ?? 0);
      acc.differential += Number(e.differential_hours ?? 0);
      if (e.source) acc.sources.add(e.source);
      return acc;
    }, { regular: 0, overtime: 0, standby: 0, callback: 0, callback_events: 0, holiday: 0, pto: 0, differential: 0, sources: new Set<string>() });

    hours = {
      regular: totals.regular,
      overtime: totals.overtime,
      standby: totals.standby,
      callback: totals.callback,
      callback_events: totals.callback_events,
      holiday: totals.holiday,
      pto: totals.pto,
      differential: totals.differential,
      days_with_entries: entries?.length ?? 0,
      sources: [...totals.sources],
      last_entry_date: entries?.at(-1)?.entry_date ?? null,
    };

    const { data: forecastRow, error: forecastError } = await admin
      .from('paycheck_forecasts')
      .select('pay_date, period_start, period_end, total_gross, total_taxes, total_deductions, estimated_net, confidence, confidence_score, confidence_reasons, days_covered, days_in_period, period_complete, created_at')
      .eq('household_id', householdId)
      .eq('pay_period_id', period.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (forecastError) throw forecastError;
    forecast = forecastRow ?? null;
  }

  const { data: latestPaystub, error: paystubError } = await admin
    .from('paystubs')
    .select('pay_date, period_start, period_end, gross_pay, net_pay, total_taxes, regular_hours, overtime_hours, earnings, source, confidence, created_at')
    .eq('household_id', householdId)
    .eq('pay_profile_id', profile.id)
    .order('pay_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (paystubError) throw paystubError;

  return {
    profile: {
      label: profile.label,
      employer_name: profile.employer_name,
      base_hourly_rate: Number(profile.base_hourly_rate),
      overtime_multiplier: Number(profile.overtime_multiplier),
      double_time_multiplier: profile.double_time_multiplier == null ? null : Number(profile.double_time_multiplier),
      standby_rate: Number(profile.standby_rate),
      standby_is_daily: profile.standby_is_daily,
      callback_minimum_hours: Number(profile.callback_minimum_hours),
      callback_multiplier: Number(profile.callback_multiplier),
      holiday_multiplier: Number(profile.holiday_multiplier),
      differential_rates: profile.differential_rates,
      recurring_deductions: profile.recurring_deductions,
      pay_frequency: profile.pay_frequency,
    },
    current_period: period ? {
      period_start: period.period_start,
      period_end: period.period_end,
      pay_date: period.pay_date,
      status: period.status,
      hours,
      forecast,
    } : null,
    latest_paystub: latestPaystub ?? null,
  };
}

async function loadBills(admin: SupabaseClient, householdId: string, lookaheadDays: number) {
  const today = new Date();
  const through = new Date(today);
  through.setUTCDate(through.getUTCDate() + lookaheadDays);

  const { data, error } = await admin
    .from('bills')
    .select('provider_name, provider_key, category, account_label, amount_due, currency, due_date, statement_date, status, source, confidence, needs_review, updated_at')
    .eq('household_id', householdId)
    .gte('due_date', isoDate(today))
    .lte('due_date', isoDate(through))
    .not('status', 'in', '(paid,ignored)')
    .order('due_date', { ascending: true });
  if (error) throw error;

  return (data ?? []).map((b: any) => ({
    provider: b.provider_name,
    provider_key: b.provider_key,
    category: b.category,
    account_label: b.account_label,
    amount_due: Number(b.amount_due),
    currency: b.currency,
    due_date: b.due_date,
    statement_date: b.statement_date,
    status: b.status,
    source: b.source,
    confidence: b.confidence == null ? null : Number(b.confidence),
    needs_review: b.needs_review,
    updated_at: b.updated_at,
  }));
}

async function loadRecentChangeSummary(admin: SupabaseClient, householdId: string, since: string) {
  const [{ count: billCount, error: billError }, { count: timeCount, error: timeError }] = await Promise.all([
    admin.from('bills').select('id', { count: 'exact', head: true }).eq('household_id', householdId).gte('updated_at', since),
    admin.from('time_entries').select('id', { count: 'exact', head: true }).eq('household_id', householdId).gte('updated_at', since),
  ]);
  if (billError) throw billError;
  if (timeError) throw timeError;

  return {
    since,
    bills_changed: billCount ?? 0,
    time_entries_changed: timeCount ?? 0,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const configured = await configuredSecret(admin);
  const presented = req.headers.get('Authorization') ?? '';
  if (!configured || !sameSecret(presented, `Bearer ${configured}`)) {
    return json({ error: 'unauthorized' }, 401);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const householdId = await resolveHousehold(admin, body?.household_id);
    const lookaheadDays = clampInt(body?.lookahead_days, 45, 7, 90);
    const since = typeof body?.since === 'string' && !Number.isNaN(Date.parse(body.since))
      ? new Date(body.since).toISOString()
      : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [payroll, upcomingBills, recentChanges] = await Promise.all([
      loadPayrollContext(admin, householdId),
      loadBills(admin, householdId, lookaheadDays),
      loadRecentChangeSummary(admin, householdId, since),
    ]);

    const missingInformation: string[] = [];
    if (!payroll.profile) missingInformation.push('No active payroll profile is available.');
    if (payroll.profile && !payroll.current_period) missingInformation.push('No open pay period is available.');
    if (payroll.current_period && payroll.current_period.hours?.days_with_entries === 0) {
      missingInformation.push('The open pay period has no imported time entries yet.');
    }
    if (!upcomingBills.length) missingInformation.push(`No verified bills are due in the next ${lookaheadDays} days.`);

    return json({
      version: 'finance-context-v1',
      household_id: householdId,
      as_of: new Date().toISOString(),
      purpose: 'App-only facts for Finances. Do not use this payload to replace connected-account balances, transactions, recurring activity, liabilities, or investments.',
      payroll,
      upcoming_bills: upcomingBills,
      recent_changes: recentChanges,
      missing_information: missingInformation,
    });
  } catch (error: any) {
    if (error?.message === 'unknown_household') return json({ error: 'unknown_household' }, 404);
    if (error?.message === 'household_id_required') return json({ error: 'household_id_required' }, 400);
    return json({ error: 'internal', message: error?.message ?? String(error) }, 500);
  }
});
