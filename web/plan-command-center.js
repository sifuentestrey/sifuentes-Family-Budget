import { loadHouseholdData } from './household-data.js';
import { buildHouseholdPlan } from '../src/engine/household-plan.js';
import { analyzeSubscriptions } from '../src/engine/subscriptions.js';
import { buildReliableSubscriptionStreams } from '../src/engine/reliable-subscriptions.js';
import { buildUpcomingObligations, obligationProvidersMatch, reconcileTrackedBill } from '../src/engine/bill-center.js';
import { detectIncomeStreams } from '../src/engine/income.js';
let billsCenterPromise = null;
const loadBillsCenter = () => billsCenterPromise ??= import('./bills-center.js');

let scheduled = false;
let rendering = false;
let dataPromise = null;

const money = (value) => Number(value || 0).toLocaleString('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const dateLabel = (date) => date ? new Date(String(date) + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
function paydayLabel(date) {
  return date ? new Date(String(date) + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric',
  }) : '—';
}
const esc = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function todayIso() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function daysApart(a, b) {
  if (!validDate(a) || !validDate(b)) return Infinity;
  return Math.abs((Date.parse(String(a) + 'T00:00:00Z')
    - Date.parse(String(b) + 'T00:00:00Z')) / 86400000);
}

function samePlanningBill(tracked, item) {
  if (!tracked || !item) return false;
  if (tracked.id && item.trackedBillId && tracked.id === item.trackedBillId) return true;
  if (tracked.id && tracked.id === item.id) return true;
  return Boolean(tracked.providerName && item.providerName
    && obligationProvidersMatch(tracked.providerName, item.providerName)
    && daysApart(tracked.dueDate, item.dueDate) <= 20);
}

function isMajorBill(bill) {
  const category = String(bill?.category || '').toLowerCase();
  return category !== 'subscriptions' || Number(bill?.amountDue || 0) >= 25;
}
function planActive() {
  return Boolean(document.querySelector('main .seg-btn[data-view="bills"].active'));
}
function ensureStyle() {
  if (document.getElementById('plan-command-center-style')) return;
  const style = document.createElement('style');
  style.id = 'plan-command-center-style';
  style.textContent = `
    [data-plan-command-center]{margin:0 0 16px}
    [data-plan-command-center] .pc-card{background:var(--surface);border:1px solid var(--border);border-radius:18px;overflow:hidden;box-shadow:var(--shadow-sm)}
    [data-plan-command-center] .pc-head{padding:15px}
    [data-plan-command-center] .pc-kicker{font-size:10.5px;font-weight:820;letter-spacing:.055em;text-transform:uppercase;color:var(--muted)}
    [data-plan-command-center] .pc-title{display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin-top:3px}
    [data-plan-command-center] .pc-title strong{font-size:22px;letter-spacing:-.035em}
    [data-plan-command-center] .pc-title span{font-size:14px;font-weight:820;color:var(--positive);white-space:nowrap}
    [data-plan-command-center] .pc-sub{font-size:11px;color:var(--muted);line-height:1.4;margin-top:3px}
    [data-plan-command-center] .pc-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 12px;padding:12px 15px;border-top:1px solid var(--border)}
    [data-plan-command-center] .pc-row-label{font-size:12.5px;font-weight:790}
    [data-plan-command-center] .pc-row-value{font-size:13px;font-weight:840;font-variant-numeric:tabular-nums}
    [data-plan-command-center] .pc-row-sub{grid-column:1/-1;font-size:10.5px;color:var(--muted);line-height:1.4}
    [data-plan-command-center] .pc-row.total{background:var(--surface-2)}
    [data-plan-command-center] .pc-row.total .pc-row-label,[data-plan-command-center] .pc-row.total .pc-row-value{font-size:14px}
    [data-plan-command-center] .pc-note{margin-top:10px;border-radius:13px;padding:11px 12px;background:var(--warn-soft);font-size:11.5px;line-height:1.45;color:var(--text)}
    [data-plan-command-center] .pc-note b{font-weight:850}
    [data-plan-command-center] .pc-bills{border-top:1px solid var(--border)}
    [data-plan-command-center] .pc-details{border-top:1px solid var(--border)}
    [data-plan-command-center] .pc-details-summary{display:flex;justify-content:space-between;align-items:center;padding:12px 15px;cursor:pointer;font-size:12.5px;font-weight:780;color:var(--text)}
    [data-plan-command-center] .pc-details-summary span{font-size:20px;color:var(--muted);transition:transform .15s}
    [data-plan-command-center] .pc-details[open] .pc-details-summary span{transform:rotate(90deg)}
    [data-plan-command-center] .pc-details-body{border-top:1px solid var(--border)}
    [data-plan-command-center] .pc-bill{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 12px;padding:11px 15px;border-top:1px solid var(--border)}
    [data-plan-command-center] .pc-bill:first-child{border-top:0}
    [data-plan-command-center] .pc-bill-name{font-size:12.5px;font-weight:780;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    [data-plan-command-center] .pc-bill-sub{font-size:10.5px;color:var(--muted);margin-top:2px}
    [data-plan-command-center] .pc-bill-value{font-size:12.5px;font-weight:820;white-space:nowrap}
    [data-plan-command-center] .pc-bills-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:12px 15px 9px}
    [data-plan-command-center] .pc-bills-head strong{font-size:12.5px;font-weight:820}
    [data-plan-command-center] .pc-bills-head span{font-size:11px;font-weight:800;color:var(--positive);white-space:nowrap}
    [data-plan-command-center] .pc-bills-sub{margin-top:2px;font-size:10.5px;color:var(--muted)}
    [data-plan-command-center] .pc-bill-content{display:flex;align-items:flex-start;gap:9px;min-width:0}
    [data-plan-command-center] .pc-status{display:flex;align-items:center;justify-content:center;flex:0 0 20px;width:20px;height:20px;margin-top:1px;border:1.5px solid var(--border-strong);border-radius:50%;font-size:13px;font-weight:900;line-height:1;color:transparent}
    [data-plan-command-center] .pc-status.paid{border-color:var(--positive);background:var(--positive-soft);color:var(--positive)}
    [data-plan-command-center] .pc-bill-main{min-width:0}
    [data-plan-command-center] .pc-bill.is-paid .pc-bill-name{color:var(--text-2)}
    [data-plan-command-center] .pc-bill-meta{font-size:10.5px;color:var(--muted);margin-top:2px;line-height:1.35}
    [data-plan-command-center] .pc-empty{padding:13px 15px;color:var(--muted);font-size:11.5px;line-height:1.4}
    [data-plan-command-center] .pc-bills-note{padding:0 15px 11px;color:var(--muted);font-size:10px;line-height:1.35}
  `;
  document.head.appendChild(style);
}
async function loadData() { return loadHouseholdData(); }
function flattenedAccounts(items) {
  return (items ?? []).flatMap((item) => (item.accounts ?? []).map((account) => ({ ...account, institution: item.institution_name })));
}
function render(host, data) {
  const { plan } = data.context;
  const next = plan.forecasts.nextPaycheck;

  if (!next) {
    host.innerHTML = '<div class="pc-note"><b>No reliable paycheck forecast yet.</b><br>Connect payroll or let the app learn a consistent income pattern before it predicts a paycheck.</div>';
    return;
  }

  const nextPlan = plan.forecasts.nextPaycheckPlan;
  const bills = nextPlan?.bills ?? [];
  const majorBills = bills.filter(isMajorBill);
  const visibleBills = majorBills.length ? majorBills : bills;
  const hiddenCount = Math.max(0, bills.length - visibleBills.length);
  const unpaidBills = bills.filter((bill) => !bill.paid);
  const unpaidTotal = Number(nextPlan?.billsTotal ?? 0);
  const before = plan.facts.dueBeforeNextPayday;
  const beforeUnpaid = (before?.bills ?? []).filter((bill) => !bill.paid);
  const after = nextPlan?.expectedCheckingAfterAssignedBills;
  const following = plan.forecasts.followingPaycheck;
  const estimate = next.status === 'incomplete'
    ? 'Not final yet'
    : (next.status === 'verified' ? money(next.amount) : '~' + money(next.amount));
  const checkWindow = following
    ? 'Expected through ' + dateLabel(following.date)
    : 'Expected bills for the next pay period';
  const billHeading = majorBills.length ? 'Major bills for this check' : 'Bills for this check';

  const billRows = visibleBills.map((bill) => {
    const paid = Boolean(bill.paid);
    const amount = paid && Number(bill.paidAmount) > 0 ? bill.paidAmount : bill.amountDue;
    const amountPrefix = !paid && (bill.amountVaries || bill.amountSource === 'recurring estimate') ? '~' : '';
    const statusText = paid
      ? 'Paid ' + dateLabel(bill.paidDate || bill.dueDate)
      : bill.needsReview ? 'Needs review · payment not confirmed'
      : bill.dueDate < todayIso()
        ? 'Needs payment · overdue'
        : 'Needs payment';
    const dueText = 'Due ' + dateLabel(bill.dueDate);
    return '<div class="pc-bill ' + (paid ? 'is-paid' : '') + '">'
      + '<div class="pc-bill-content">'
      + '<span class="pc-status ' + (paid ? 'paid' : 'pending') + '" aria-label="' + (paid ? 'Paid' : 'Needs payment') + '">' + (paid ? '✓' : '') + '</span>'
      + '<span class="pc-bill-main"><div class="pc-bill-name">' + esc(bill.providerName) + '</div>'
      + '<div class="pc-bill-meta">' + esc(statusText) + ' · ' + esc(dueText) + '</div></span>'
      + '</div>'
      + '<span class="pc-bill-value">' + amountPrefix + money(amount) + '</span>'
      + '</div>';
  }).join('');

  const billList = visibleBills.length
    ? billRows
    : '<div class="pc-empty">No major bills are assigned to this paycheck yet.</div>';
  const smallerNote = hiddenCount
    ? '<div class="pc-bills-note">' + hiddenCount + ' smaller recurring item'
      + (hiddenCount === 1 ? '' : 's') + ' included in the total.</div>'
    : '';
  const billSummary = unpaidTotal > 0
    ? money(unpaidTotal) + ' to cover'
    : 'All handled';
  const beforeSummary = beforeUnpaid.length
    ? beforeUnpaid.length + ' unpaid bill' + (beforeUnpaid.length === 1 ? '' : 's')
      + ' need to be covered before ' + dateLabel(next.date) + '.'
    : 'No unpaid bills are due before this paycheck.';
  const assignedSummary = unpaidBills.length
    ? unpaidBills.length + ' unpaid bill' + (unpaidBills.length === 1 ? '' : 's')
      + ' included in the amount above.'
    : 'Nothing remains to set aside for these bills.';
  const afterLabel = after === null
    ? 'Waiting for final timecard'
    : money(after);
  const afterSummary = after === null
    ? 'The paycheck is not final, so the after-bills number is withheld.'
    : 'Current checking plus this paycheck, less unpaid bills assigned to it.';
  const note = plan.attention[0];
  const noteHtml = note
    ? '<div class="pc-note"><b>' + esc(note.label) + '</b><br>' + esc(note.reason) + '</div>'
    : '';

  host.innerHTML = '<div class="pc-card">'
    + '<div class="pc-head">'
    + '<div class="pc-kicker">Next paycheck</div>'
    + '<div class="pc-title"><strong>' + esc(paydayLabel(next.date)) + '</strong><span>' + estimate + '</span></div>'
    + '<div class="pc-sub">' + esc(next.status === 'verified' ? 'Verified deposit' : 'Estimated take-home')
      + ' · ' + esc(next.basis) + '.</div>'
    + '</div>'
    + '<div class="pc-bills">'
    + '<div class="pc-bills-head"><div><strong>' + billHeading + '</strong><div class="pc-bills-sub">'
      + esc(checkWindow) + '</div></div><span>' + billSummary + '</span></div>'
    + billList
    + smallerNote
    + '</div>'
    + '<details class="pc-details">'
    + '<summary class="pc-details-summary">Show plan details <span>›</span></summary>'
    + '<div class="pc-details-body">'
    + '<div class="pc-row"><div class="pc-row-label">Checking available now</div><div class="pc-row-value">'
      + money(plan.facts.checking.available) + '</div><div class="pc-row-sub">Savings is not included.</div></div>'
    + '<div class="pc-row"><div class="pc-row-label">Before the next paycheck</div><div class="pc-row-value">'
      + money(before.total) + '</div><div class="pc-row-sub">' + esc(beforeSummary) + '</div></div>'
    + '<div class="pc-row"><div class="pc-row-label">Still to cover from this check</div><div class="pc-row-value">'
      + money(unpaidTotal) + '</div><div class="pc-row-sub">' + esc(assignedSummary) + '</div></div>'
    + '<div class="pc-row total"><div class="pc-row-label">Expected checking after bills</div><div class="pc-row-value">'
      + afterLabel + '</div><div class="pc-row-sub">' + esc(afterSummary) + '</div></div>'
    + '</div></details>'
    + '</div>'
    + noteHtml;
}
async function run() {
  if (!planActive() || rendering) {
    if (!planActive()) dataPromise = null;
    return;
  }
  rendering = true;
  try {
    await (await loadBillsCenter()).enhanceBillsView();
    const center = document.querySelector('[data-bill-center]');
    if (!center || center.querySelector('[data-plan-command-center]')) return;
    ensureStyle();
    const data = await loadData();
    if (!data || !planActive()) return;
    const host = document.createElement('div');
    host.dataset.planCommandCenter = '1';
    center.insertBefore(host, center.firstChild);
    render(host, data);
  } catch {
    // The bill calendar stays available if the additional plan summary cannot load.
  } finally {
    rendering = false;
  }
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; run(); });
}
new MutationObserver(schedule).observe(document.getElementById('app') ?? document.body, { childList: true, subtree: true });
schedule();

window.addEventListener('family-budget:data-changed', () => {
  dataPromise = null;
  document.querySelector('[data-plan-command-center]')?.remove();
  schedule();
});
