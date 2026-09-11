import { nextPayPeriod, forecastPaycheck } from './forecast.js';
import { rowToProfile, rowToEntry } from './mapping.js';
import { detectIncomeStreams } from '../engine/income.js';

export async function loadHouseholdPaychecks(supabase, transactions, asOf) {
  const [{ data: profiles, error }, { data: stubs, error: stubError }] = await Promise.all([
    supabase.from('pay_profiles').select('*').eq('is_active', true),
    supabase.from('paystubs').select('pay_profile_id,pay_date,net_pay').gte('pay_date', asOf),
  ]);
  if (error || stubError) throw error || stubError;
  const streams = detectIncomeStreams(transactions);
  const result = [];
  for (const row of profiles || []) {
    const profile = rowToProfile(row);
    const lag = profile.paydayLagDays ?? (profile.payday && profile.payPeriodEnd
      ? Math.round((Date.parse(profile.payday) - Date.parse(profile.payPeriodEnd)) / 86400000) : 0);
    const workDate = new Date(Date.parse(asOf) - Math.max(0, lag) * 86400000).toISOString().slice(0, 10);
    const upcoming = nextPayPeriod(profile, workDate);
    if (!upcoming) continue;
    const employer = String(row.employer_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const matching = streams.filter(s => {
      const name = String(s.payee || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return employer.length > 4 && (name.includes(employer) || employer.includes(name));
    });
    // Ambiguous identity must not double-count bank history and payroll.
    if (matching.length !== 1 && streams.length) continue;
    const stream = matching[0];
    const streamId = stream ? stream.id || `${stream.account_id}:${stream.payee}` : `payroll:${row.id}`;
    const stub = stubs?.find(s => s.pay_profile_id === row.id && s.pay_date === upcoming.payDate);
    if (stub) {
      result.push({ date: stub.pay_date, amount: Number(stub.net_pay), status: 'verified', streamId, payee: row.employer_name });
      continue;
    }
    const { data: entries, error: entryError } = await supabase.from('time_entries').select('*')
      .eq('pay_profile_id', row.id).gte('entry_date', upcoming.period.start).lte('entry_date', upcoming.period.end);
    if (entryError) throw entryError;
    if (!entries?.length) continue;
    const estimate = forecastPaycheck({ profile, entries: entries.map(rowToEntry), ...upcoming, asOf });
    result.push({ date: upcoming.payDate, amount: estimate.projectedFromPartial ?? estimate.estimatedNet,
      status: 'incomplete', confidence: estimate.confidence, streamId, payee: row.employer_name,
      basis: 'imported timecard; payroll completion not verified' });
  }
  return result;
}

