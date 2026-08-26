import { buildHouseholdPlan } from '../src/engine/household-plan.js';
import { analyzeSubscriptions } from '../src/engine/subscriptions.js';
import { buildReliableSubscriptionStreams } from '../src/engine/reliable-subscriptions.js';
import { buildUpcomingObligations, obligationProvidersMatch } from '../src/engine/bill-center.js';
import { detectIncomeStreams } from '../src/engine/income.js';
let billsCenterPromise = null;
const loadBillsCenter = () => billsCenterPromise ??= import('./bills-center.js');

let scheduled = false;
let rendering = false;
let dataPromise = null;

const money = (value) => Number(value || 0).toLocaleString('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const dateLabel = (date) => date ? new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
const esc = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function todayIso() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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
  `;
  document.head.appendChild(style);
}
async function loadData() {
  if (!dataPromise) {
    dataPromise = Promise.all([import('./connect.js'), import('./bills.js'), import('./budget-targets.js')])
      .then(async ([connect, bills, budgetTargets]) => {
        if (!await connect.getSession()) return null;
        const [items, transactions, rawBills, suppressions, targets] = await Promise.all([
          connect.listConnectedItems(), connect.listTransactions(), bills.listBillsForCenter(),
          bills.listBillSuppressions(), budgetTargets.listBudgetTargets(),
        ]);
        const recurring = [
          ...(analyzeSubscriptions(transactions).bills ?? []),
          ...buildReliableSubscriptionStreams(transactions, { asOf: todayIso() }),
        ].filter((stream) => !suppressions.some((marker) => obligationProvidersMatch(marker.providerName, stream.payee)));
        const tracked = rawBills.filter((bill) => !suppressions.some((marker) => obligationProvidersMatch(marker.providerName, bill.providerName)));
        return {
          items,
          transactions,
          targets,
          bills: buildUpcomingObligations({ bills: tracked, recurring, transactions, asOf: todayIso() }),
          incomeStreams: detectIncomeStreams(transactions),
        };
      });
  }
  return dataPromise;
}
function flattenedAccounts(items) {
  return (items ?? []).flatMap((item) => (item.accounts ?? []).map((account) => ({ ...account, institution: item.institution_name })));
}
function render(host, data) {
  const plan = buildHouseholdPlan({
    asOf: todayIso(),
    accounts: flattenedAccounts(data.items),
    bills: data.bills,
    incomeStreams: data.incomeStreams,
    budgetTargets: data.targets,
    transactions: data.transactions,
  });
  const next = plan.forecasts.nextPaycheck;
  const nextPlan = plan.forecasts.nextPaycheckPlan;
  const before = plan.facts.dueBeforeNextPayday;
  const planBills = nextPlan?.bills ?? [];
  const after = nextPlan?.expectedCheckingAfterAssignedBills;
  const note = plan.attention[0];
  host.innerHTML = next ? `
    <div class="pc-card">
      <div class="pc-head">
        <div class="pc-kicker">Next paycheck plan</div>
        <div class="pc-title"><strong>${dateLabel(next.date)}</strong><span>${next.status === 'incomplete' ? 'Not final yet' : money(next.amount)}</span></div>
        <div class="pc-sub">${esc(next.confidence)} confidence · Based on ${esc(next.basis)}.</div>
      </div>
      <details class="pc-details">
        <summary class="pc-details-summary">Show plan details <span>›</span></summary>
        <div class="pc-details-body">
      <div class="pc-row">
          <div class="pc-row-label">Checking available now</div><div class="pc-row-value">${money(plan.facts.checking.available)}</div>
          <div class="pc-row-sub">Current fact from connected checking. Savings is not included.</div>
        </div>
        <div class="pc-row">
          <div class="pc-row-label">Bills due before payday</div><div class="pc-row-value">${money(before.total)}</div>
          <div class="pc-row-sub">${before.bills.length ? `${before.bills.length} bill${before.bills.length === 1 ? '' : 's'} must be covered before ${dateLabel(next.date)}.` : 'No open bills are due before this paycheck.'}</div>
        </div>
        <div class="pc-row">
          <div class="pc-row-label">Assigned to this paycheck</div><div class="pc-row-value">${money(nextPlan?.billsTotal)}</div>
          <div class="pc-row-sub">Each bill is assigned to the latest paycheck that arrives on or before its due date.</div>
        </div>
        <div class="pc-row total">
          <div class="pc-row-label">Expected checking after this plan</div><div class="pc-row-value">${after === null ? 'Waiting for final timecard' : money(after)}</div>
          <div class="pc-row-sub">${after === null ? 'The next paycheck is not final, so this forecast is intentionally withheld.' : 'Forecast based on current available checking, this paycheck, and assigned bills.'}</div>
        </div>
        ${planBills.length ? `<div class="pc-bills">${planBills.map((bill) => `<div class="pc-bill"><span><div class="pc-bill-name">${esc(bill.providerName)}</div><div class="pc-bill-sub">Due ${dateLabel(bill.dueDate)} · ${esc(bill.amountSource)}</div></span><span class="pc-bill-value">${money(bill.amountDue)}</span></div>`).join('')}</div>` : ''}
        </div>
      </details>
    </div>
    ${note ? `<div class="pc-note"><b>${esc(note.label)}</b><br>${esc(note.reason)}</div>` : ''}
  ` : '<div class="pc-note"><b>No reliable paycheck forecast yet.</b><br>Connect payroll or let the app learn a consistent income pattern before it predicts a paycheck.</div>';
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
