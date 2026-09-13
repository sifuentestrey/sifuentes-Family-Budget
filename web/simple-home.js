import { loadHouseholdData } from './household-data.js';
import { buildHouseholdPlan } from '../src/engine/household-plan.js';
import { analyzeSubscriptions } from '../src/engine/subscriptions.js';
import { buildReliableSubscriptionStreams } from '../src/engine/reliable-subscriptions.js';
import { buildUpcomingObligations, obligationProvidersMatch } from '../src/engine/bill-center.js';
import { detectIncomeStreams } from '../src/engine/income.js';

let dataPromise = null;
let running = false;
let scheduled = false;

const money = (n) => Number(n || 0).toLocaleString('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const money0 = (n) => Number(n || 0).toLocaleString('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});
const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateLabel(date) {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function dashboardActive() {
  const title = document.querySelector('.app-bar-title')?.textContent.trim();
  return title === 'Home' && Boolean(document.querySelector('.tabbar .tab')?.classList.contains('active'));
}

function ensureStyle() {
  if (document.getElementById('simple-home-style')) return;
  const style = document.createElement('style');
  style.id = 'simple-home-style';
  style.textContent = `
    [data-simple-home] .sh-hero{background:var(--hero-bg);color:var(--hero-ink);border-radius:18px;padding:18px;box-shadow:none}
    [data-simple-home] .sh-label{font-size:11px;font-weight:800;letter-spacing:.055em;text-transform:uppercase;color:var(--hero-label)}
    [data-simple-home] .sh-balance{font-size:37px;line-height:1.05;font-weight:860;letter-spacing:-.045em;margin:4px 0 5px;font-variant-numeric:tabular-nums}
    [data-simple-home] .sh-foot{padding-top:11px;margin-top:11px;border-top:1px solid var(--hero-rule);font-size:12px;color:var(--hero-note)}
    [data-simple-home] .sh-card,.sh-list{background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden;box-shadow:none}
    [data-simple-home] .sh-section{margin-top:18px}
    [data-simple-home] .sh-section-head{display:flex;justify-content:space-between;align-items:baseline;margin:0 3px 7px}
    [data-simple-home] .sh-section-title{font-size:16px;font-weight:820;letter-spacing:-.025em}
    [data-simple-home] .sh-section-note{font-size:11px;color:var(--muted)}
    [data-simple-home] .sh-link{border:0;background:none;color:var(--accent);font:inherit;font-size:11px;font-weight:800;padding:0}
    [data-simple-home] .sh-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 13px;border-top:1px solid var(--border);background:transparent;color:var(--text);width:100%;text-align:left;font:inherit}
    [data-simple-home] .sh-row:first-child{border-top:0}
    [data-simple-home] .sh-row-title{font-size:13.5px;font-weight:790;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    [data-simple-home] .sh-row-sub{font-size:10.8px;color:var(--muted);margin-top:2px;line-height:1.35}
    [data-simple-home] .sh-row-value{font-size:12.5px;font-weight:820;white-space:nowrap;font-variant-numeric:tabular-nums}
    [data-simple-home] .sh-allowance{padding:13px;border-top:1px solid var(--border)}
    [data-simple-home] .sh-allowance:first-child{border-top:0}
    [data-simple-home] .sh-allowance-top{display:flex;justify-content:space-between;gap:10px;font-size:13px;font-weight:790}
    [data-simple-home] .sh-allowance-note{font-size:10.8px;color:var(--muted);margin-top:2px}
    [data-simple-home] .sh-meter{height:7px;background:var(--quiet-soft);border-radius:999px;overflow:hidden;margin-top:8px}
    [data-simple-home] .sh-meter i{display:block;height:100%;background:var(--accent);border-radius:999px}
    [data-simple-home] .sh-attention{margin-top:12px;border:1px solid color-mix(in srgb,var(--warn) 24%,var(--border));border-radius:12px;padding:11px;background:var(--warn-soft);color:var(--text);font-size:12px;line-height:1.45;text-align:left;width:100%}
    [data-simple-home] .sh-attention b{display:block;font-weight:850;margin-bottom:2px}
    [data-simple-home] .sh-plan{padding:14px;text-align:left;color:var(--text);font:inherit;width:100%}
    [data-simple-home] .sh-plan-title{font-size:13.5px;font-weight:820}
    [data-simple-home] .sh-plan-value{font-size:25px;line-height:1.12;font-weight:850;letter-spacing:-.035em;margin:2px 0}
    [data-simple-home] .sh-empty{padding:18px 14px;color:var(--muted);font-size:12px;line-height:1.45}
  `;
  document.head.appendChild(style);
}

async function loadData() { return loadHouseholdData(); }

function accountPicture(items) {
  const accounts = [];
  for (const item of items ?? []) {
    for (const account of item.accounts ?? []) {
      accounts.push({ ...account, institution: item.institution_name });
    }
  }
  return accounts;
}

function recurringFor(data) {
  const streams = [
    ...(analyzeSubscriptions(data.transactions).bills ?? []),
    ...buildReliableSubscriptionStreams(data.transactions, { asOf: todayIso() }),
  ];
  return streams.filter((stream) => !data.suppressions.some((marker) =>
    obligationProvidersMatch(marker.providerName, stream.payee),
  ));
}

function routeButton(label, sub, value, view) {
  return `<button class="sh-row" type="button" data-home-route="${view}">
    <span><div class="sh-row-title">${esc(label)}</div><div class="sh-row-sub">${esc(sub)}</div></span>
    <span class="sh-row-value">${esc(value)}</span>
  </button>`;
}

function render(host, data) {
  const { plan, dataHealth } = data.context;
  const next = plan.forecasts.nextPaycheck;
  const nextPlan = plan.forecasts.nextPaycheckPlan;
  const due = plan.facts.dueBeforeNextPayday;
  const attention = plan.attention[0] ?? null;
  const allowances = plan.allowances ?? [];
  const flexibleLeft = allowances.reduce((sum, allowance) => sum + Number(allowance.left || 0), 0);
  const flexibleNames = allowances.slice(0, 3).map((allowance) => allowance.category).filter(Boolean).join(', ');
  const flexibleMore = allowances.length > 3 ? ` + ${allowances.length - 3} more` : '';
  const flexibleNote = allowances.length
    ? `${flexibleNames}${flexibleMore} · through ${next ? dateLabel(next.date) : 'your next payday'}`
    : 'Set targets for groceries, gas, and extras';
  const notice = dataHealth.stale
    ? { title: 'Bank data may be out of date', body: 'Refresh accounts before relying on this plan.' }
    : data.payrollError
      ? { title: 'Paycheck forecast needs attention', body: data.payrollError }
      : attention
        ? { title: attention.label, body: attention.reason, route: 'bills' }
        : null;
  const nextPaycheckValue = next
    ? next.status === 'incomplete' ? 'Not final' : money(next.amount)
    : '—';

  host.innerHTML = `
    <div class="sh-hero">
      <div class="sh-label">Checking now</div>
      <div class="sh-balance">${money(plan.facts.checking.available)}</div>
      <div class="sh-foot">${plan.diagnostics.checkingBalanceIsAvailable ? 'Available balance from connected checking' : 'Current balance; provider did not report an available balance'}${plan.facts.savings.accountCount ? ` · ${money(plan.facts.savings.available)} savings` : ''}</div>
    </div>

    ${notice ? notice.route
      ? `<button class="sh-attention" type="button" data-home-route="${notice.route}"><b>${esc(notice.title)}</b>${esc(notice.body)}</button>`
      : `<div class="sh-attention"><b>${esc(notice.title)}</b>${esc(notice.body)}</div>` : ''}

    <section class="sh-section">
      <div class="sh-section-head"><div><div class="sh-section-title">Next up</div><div class="sh-section-note">The two numbers that affect the next decision</div></div><button class="sh-link" data-home-route="bills">Open bills</button></div>
      <div class="sh-list">
        ${routeButton('Next paycheck', next ? `Expected ${dateLabel(next.date)} · ${next.confidence} confidence` : 'No reliable forecast yet', nextPaycheckValue, 'bills')}
        ${routeButton('Bills before then', `${due.bills.length} open bill${due.bills.length === 1 ? '' : 's'}`, money(due.total), 'bills')}
      </div>
    </section>

    <section class="sh-section">
      <div class="sh-section-head"><div><div class="sh-section-title">Until payday</div><div class="sh-section-note">${esc(flexibleNote)}</div></div><button class="sh-link" data-home-route="budget">Edit budget</button></div>
      <button class="sh-card sh-plan" type="button" data-home-route="budget">
        <div class="sh-plan-title">${allowances.length ? 'Left across your targets' : 'Set up your targets'}</div>
        <div class="sh-plan-value">${allowances.length ? `${money0(flexibleLeft)} left` : 'Groceries, gas, extras'}</div>
        <div class="sh-row-sub">${allowances.length && nextPlan?.billsTotal ? `${money(nextPlan.billsTotal)} is reserved for bills before flexible spending.` : 'The app will keep this separate from fixed bills.'}</div>
      </button>
    </section>
  `;

  host.querySelectorAll('[data-home-route]').forEach((button) => button.addEventListener('click', () => {
    window.__familyBudgetRoute?.(button.dataset.homeRoute);
  }));
}

function mount(data) {
  const main = document.querySelector('main');
  if (!main || !dashboardActive() || main.querySelector('[data-simple-home]')) return;
  const host = document.createElement('div');
  host.dataset.simpleHome = '1';
  main.appendChild(host);
  for (const child of [...main.children]) if (child !== host) child.hidden = true;
  render(host, data);
}

async function run() {
  if (!dashboardActive()) { dataPromise = null; return; }
  if (running || document.querySelector('main [data-simple-home]')) return;
  running = true;
  try {
    ensureStyle();
    const data = await loadData();
    if (data && dashboardActive()) mount(data);
  } catch {
    // The original dashboard remains available if connected data cannot load.
  } finally {
    running = false;
  }
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => { scheduled = false; run(); }, 0);
}

new MutationObserver(schedule).observe(document.getElementById('app') ?? document.body, { childList: true, subtree: true });
schedule();

window.addEventListener('family-budget:data-changed', () => {
  dataPromise = null;
  document.querySelector('main [data-simple-home]')?.remove();
  schedule();
});
