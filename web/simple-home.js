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
    [data-simple-home] .sh-hero{background:var(--hero-bg);color:var(--hero-ink);border-radius:22px;padding:19px;box-shadow:var(--shadow-md)}
    [data-simple-home] .sh-label{font-size:11px;font-weight:800;letter-spacing:.055em;text-transform:uppercase;color:var(--hero-label)}
    [data-simple-home] .sh-balance{font-size:37px;line-height:1.05;font-weight:860;letter-spacing:-.045em;margin:4px 0 5px;font-variant-numeric:tabular-nums}
    [data-simple-home] .sh-foot{padding-top:11px;margin-top:11px;border-top:1px solid var(--hero-rule);font-size:12px;color:var(--hero-note)}
    [data-simple-home] .sh-card,.sh-list{background:var(--surface);border:1px solid var(--border);border-radius:18px;overflow:hidden;box-shadow:var(--shadow-sm)}
    [data-simple-home] .sh-section{margin-top:20px}
    [data-simple-home] .sh-section-head{display:flex;justify-content:space-between;align-items:baseline;margin:0 3px 7px}
    [data-simple-home] .sh-section-title{font-size:16px;font-weight:820;letter-spacing:-.025em}
    [data-simple-home] .sh-section-note{font-size:11px;color:var(--muted)}
    [data-simple-home] .sh-link{border:0;background:none;color:var(--accent);font:inherit;font-size:11px;font-weight:800;padding:0}
    [data-simple-home] .sh-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:13px 14px;border-top:1px solid var(--border);background:transparent;color:var(--text);width:100%;text-align:left;font:inherit}
    [data-simple-home] .sh-row:first-child{border-top:0}
    [data-simple-home] .sh-row-title{font-size:13.5px;font-weight:790;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    [data-simple-home] .sh-row-sub{font-size:10.8px;color:var(--muted);margin-top:2px;line-height:1.35}
    [data-simple-home] .sh-row-value{font-size:12.5px;font-weight:820;white-space:nowrap;font-variant-numeric:tabular-nums}
    [data-simple-home] .sh-allowance{padding:14px;border-top:1px solid var(--border)}
    [data-simple-home] .sh-allowance:first-child{border-top:0}
    [data-simple-home] .sh-allowance-top{display:flex;justify-content:space-between;gap:10px;font-size:13px;font-weight:790}
    [data-simple-home] .sh-allowance-note{font-size:10.8px;color:var(--muted);margin-top:2px}
    [data-simple-home] .sh-meter{height:7px;background:var(--quiet-soft);border-radius:999px;overflow:hidden;margin-top:8px}
    [data-simple-home] .sh-meter i{display:block;height:100%;background:var(--accent);border-radius:999px}
    [data-simple-home] .sh-attention{margin-top:12px;border-radius:14px;padding:12px;background:var(--warn-soft);color:var(--text);font-size:12px;line-height:1.45}
    [data-simple-home] .sh-attention b{display:block;font-weight:850;margin-bottom:2px}
    [data-simple-home] .sh-plan{padding:15px}
    [data-simple-home] .sh-plan-title{font-size:13.5px;font-weight:820}
    [data-simple-home] .sh-plan-value{font-size:25px;line-height:1.12;font-weight:850;letter-spacing:-.035em;margin:2px 0}
    [data-simple-home] .sh-empty{padding:18px 14px;color:var(--muted);font-size:12px;line-height:1.45}
  `;
  document.head.appendChild(style);
}

async function loadData() {
  if (!dataPromise) {
    dataPromise = Promise.all([
      import('./connect.js'), import('./bills.js'), import('./budget-targets.js'),
    ]).then(async ([connect, bills, budgetTargets]) => {
      if (!await connect.getSession()) return null;
      const [items, transactions, rawBills, suppressions, targets] = await Promise.all([
        connect.listConnectedItems(), connect.listTransactions(), bills.listBillsForCenter(),
        bills.listBillSuppressions(), budgetTargets.listBudgetTargets(),
      ]);
      return { items, transactions, rawBills, suppressions, targets };
    });
  }
  return dataPromise;
}

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
  const asOf = todayIso();
  const recurring = recurringFor(data);
  const bills = data.rawBills.filter((bill) => !data.suppressions.some((marker) =>
    obligationProvidersMatch(marker.providerName, bill.providerName),
  ));
  const obligations = buildUpcomingObligations({ bills, recurring, transactions: data.transactions, asOf });
  const plan = buildHouseholdPlan({
    asOf,
    accounts: accountPicture(data.items),
    bills: obligations,
    incomeStreams: detectIncomeStreams(data.transactions),
    budgetTargets: data.targets,
    transactions: data.transactions,
  });
  const next = plan.forecasts.nextPaycheck;
  const nextPlan = plan.forecasts.nextPaycheckPlan;
  const due = plan.facts.dueBeforeNextPayday;
  const attention = plan.attention[0] ?? null;

  host.innerHTML = `
    <div class="sh-hero">
      <div class="sh-label">Checking now</div>
      <div class="sh-balance">${money(plan.facts.checking.available)}</div>
      <div class="sh-foot">${plan.diagnostics.checkingBalanceIsAvailable ? 'Available balance from connected checking' : 'Current balance; provider did not report an available balance'}${plan.facts.savings.accountCount ? ` · ${money(plan.facts.savings.available)} savings` : ''}</div>
    </div>

    ${attention ? `<button class="sh-attention" type="button" data-home-route="bills"><b>${esc(attention.label)}</b>${esc(attention.reason)}</button>` : ''}

    <section class="sh-section">
      <div class="sh-section-head"><div><div class="sh-section-title">Until payday</div><div class="sh-section-note">${next ? `Flexible spending through ${dateLabel(next.date)}` : 'Set up a reliable payday to use allowances'}</div></div><button class="sh-link" data-home-route="budget">Edit budget</button></div>
      <div class="sh-list">${plan.allowances.length ? plan.allowances.map((allowance) => {
        const percent = allowance.planned ? Math.min(100, allowance.spent / allowance.planned * 100) : 0;
        return `<button class="sh-allowance" type="button" data-home-route="budget">
          <div class="sh-allowance-top"><span>${esc(allowance.category)}</span><span>${money0(allowance.left)} left</span></div>
          <div class="sh-allowance-note">${esc(allowance.label)} · ${allowance.daysRemaining} days remaining</div>
          <div class="sh-meter"><i style="width:${percent}%"></i></div>
        </button>`;
      }).join('') : '<div class="sh-empty">Choose a monthly target for groceries, restaurants, gas, or household/fun to see a simple allowance here.</div>'}</div>
    </section>

    <section class="sh-section">
      <div class="sh-section-head"><div><div class="sh-section-title">${esc(due.label)}</div><div class="sh-section-note">Current fact · not a forecast</div></div><button class="sh-link" data-home-route="bills">Open Plan</button></div>
      <div class="sh-list">${due.bills.length ? due.bills.slice(0, 3).map((bill) =>
        routeButton(bill.providerName, `Due ${dateLabel(bill.dueDate)} · ${bill.amountSource}`, money(bill.amountDue), 'bills'),
      ).join('') + (due.bills.length > 3 ? routeButton(`${due.bills.length - 3} more bill${due.bills.length === 4 ? '' : 's'}`, 'See every bill in Plan', money(due.total), 'bills') : '') : '<div class="sh-empty">No open bills are due before the next known paycheck.</div>'}</div>
    </section>

    <section class="sh-section">
      <div class="sh-section-head"><div class="sh-section-title">Next paycheck</div><button class="sh-link" data-home-route="income">Income details</button></div>
      <button class="sh-card sh-plan" type="button" data-home-route="bills">
        ${next ? `<div class="sh-plan-title">Expected ${dateLabel(next.date)} · ${esc(next.confidence)} confidence</div>
          <div class="sh-plan-value">${next.status === 'incomplete' ? 'Not final yet' : money(next.amount)}</div>
          <div class="sh-row-sub">Based on ${esc(next.basis)}. ${nextPlan?.billsTotal ? `${money(nextPlan.billsTotal)} assigned to bills.` : 'No bills assigned yet.'}</div>`
          : '<div class="sh-plan-title">No reliable paycheck forecast yet</div><div class="sh-row-sub">Connect payroll or let the app learn a consistent income pattern before it projects a paycheck.</div>'}
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
