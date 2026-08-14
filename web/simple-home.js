import { buildAdaptiveBudget } from '../src/engine/adaptive-budget.js';
import { analyzeSubscriptions } from '../src/engine/subscriptions.js';
import { buildReliableSubscriptionStreams } from '../src/engine/reliable-subscriptions.js';
import { buildBillMonth, obligationProvidersMatch } from '../src/engine/bill-center.js';
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
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long' });
}
function dateLabel(date) {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function dashboardActive() {
  const title = document.querySelector('.app-bar-title')?.textContent.trim();
  const tabs = [...document.querySelectorAll('.tabbar .tab')];
  return title === 'Home' && Boolean(tabs[0]?.classList.contains('active'));
}

function ensureStyle() {
  if (document.getElementById('simple-home-style')) return;
  const style = document.createElement('style');
  style.id = 'simple-home-style';
  style.textContent = `
    [data-simple-home] .sh-hero{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:17px;box-shadow:var(--shadow-sm)}
    [data-simple-home] .sh-label{font-size:11px;font-weight:800;letter-spacing:.055em;text-transform:uppercase;color:var(--muted)}
    [data-simple-home] .sh-balance{font-size:36px;line-height:1.05;font-weight:860;letter-spacing:-.045em;margin:4px 0 5px;font-variant-numeric:tabular-nums}
    [data-simple-home] .sh-foot{display:flex;gap:13px;flex-wrap:wrap;padding-top:11px;margin-top:11px;border-top:1px solid var(--border);font-size:11.5px;color:var(--muted)}
    [data-simple-home] .sh-foot b{color:var(--text);font-weight:800}
    [data-simple-home] .sh-card{margin-top:12px;background:var(--surface);border:1px solid var(--border);border-radius:18px;overflow:hidden;box-shadow:var(--shadow-sm)}
    [data-simple-home] .sh-month-head{padding:15px 15px 12px}
    [data-simple-home] .sh-month-title{font-size:12px;color:var(--muted);font-weight:750}
    [data-simple-home] .sh-month-value{font-size:29px;line-height:1.1;font-weight:850;letter-spacing:-.035em;margin-top:2px}
    [data-simple-home] .sh-budget-line{display:flex;justify-content:space-between;gap:12px;margin-top:8px;font-size:11px;color:var(--muted)}
    [data-simple-home] .sh-meter{height:7px;background:var(--quiet-soft);border-radius:999px;overflow:hidden;margin-top:7px}
    [data-simple-home] .sh-meter i{display:block;height:100%;background:var(--accent);border-radius:999px}
    [data-simple-home] .sh-row{display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:11px;align-items:center;padding:13px 14px;border-top:1px solid var(--border);background:transparent;color:var(--text);width:100%;text-align:left;font:inherit}
    [data-simple-home] .sh-row-icon{width:38px;height:38px;border-radius:12px;background:var(--surface-2);display:grid;place-items:center;font-size:17px;font-weight:850;color:var(--text-2);overflow:hidden}
    [data-simple-home] .sh-row-icon img{width:100%;height:100%;object-fit:cover}
    [data-simple-home] .sh-row-title{font-size:13.5px;font-weight:790;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    [data-simple-home] .sh-row-sub{font-size:10.5px;color:var(--muted);margin-top:1px;line-height:1.35}
    [data-simple-home] .sh-row-value{font-size:12.5px;font-weight:820;white-space:nowrap;font-variant-numeric:tabular-nums}
    [data-simple-home] .sh-row-value.income{color:var(--positive)}
    [data-simple-home] .sh-section{margin-top:20px}
    [data-simple-home] .sh-section-head{display:flex;justify-content:space-between;align-items:baseline;margin:0 3px 7px}
    [data-simple-home] .sh-section-title{font-size:16px;font-weight:820;letter-spacing:-.025em}
    [data-simple-home] .sh-link{border:0;background:none;color:var(--accent);font:inherit;font-size:11px;font-weight:800;padding:0}
    [data-simple-home] .sh-list{background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden}
    [data-simple-home] .sh-list .sh-row:first-child{border-top:0}
    [data-simple-home] .sh-attention{margin-top:12px;border-radius:14px;padding:11px 12px;background:var(--warn-soft);color:var(--text);font-size:11.5px;line-height:1.45}
    [data-simple-home] .sh-attention b{font-weight:850}
  `;
  document.head.appendChild(style);
}

async function loadData() {
  if (!dataPromise) {
    dataPromise = Promise.all([
      import('./connect.js'), import('./bills.js'), import('./budget-targets.js'),
    ]).then(async ([connect, bills, budgetTargets]) => {
      const session = await connect.getSession();
      if (!session) return null;
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
  let checking = 0;
  let savings = 0;
  let owed = 0;
  const accounts = [];
  for (const item of items ?? []) {
    for (const account of item.accounts ?? []) {
      const amount = Number(account.current_balance || 0);
      const type = account.type || 'other';
      if (type === 'credit') owed += Math.abs(amount);
      else if (type === 'savings') savings += amount;
      else if (type === 'checking') checking += amount;
      accounts.push({ ...account, institution: item.institution_name, amount });
    }
  }
  return { checking, savings, owed, cash: checking + savings, accounts };
}

function recurringFor(data) {
  const analysis = analyzeSubscriptions(data.transactions);
  const streams = [
    ...(analysis.bills ?? []),
    ...buildReliableSubscriptionStreams(data.transactions, { asOf: todayIso() }),
  ];
  return streams.filter((stream) => !data.suppressions.some((marker) =>
    obligationProvidersMatch(marker.providerName, stream.payee),
  ));
}

function logo(payee, transactions) {
  return transactions.find((t) => t.payee === payee && t.logo_url)?.logo_url ?? null;
}

function initial(name) {
  return esc(String(name || '?').trim().charAt(0).toUpperCase() || '?');
}

function routeButton(label, sub, value, iconText, view) {
  return `<button class="sh-row" type="button" data-home-route="${view}">
    <span class="sh-row-icon">${iconText}</span>
    <span><div class="sh-row-title">${label}</div><div class="sh-row-sub">${sub}</div></span>
    <span class="sh-row-value">${value}</span>
  </button>`;
}

function render(host, data) {
  const month = todayIso().slice(0, 7);
  const accounts = accountPicture(data.items);
  const budget = buildAdaptiveBudget({ transactions: data.transactions, targets: data.targets, month });
  const recurring = recurringFor(data);
  const bills = data.rawBills.filter((bill) => !data.suppressions.some((marker) =>
    obligationProvidersMatch(marker.providerName, bill.providerName),
  ));
  const billMonth = buildBillMonth({ bills, recurring, transactions: data.transactions, month });
  const incomeStreams = detectIncomeStreams(data.transactions);
  const nextPayday = incomeStreams.map((s) => s.next_expected).filter((d) => d && d >= todayIso()).sort()[0] ?? null;
  const budgetPct = budget.totals.planned > 0
    ? Math.min(100, Math.max(0, budget.totals.spent / budget.totals.planned * 100))
    : 0;
  const nextDue = billMonth.rows.filter((row) => !row.paid).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0] ?? null;
  const dueSoon = billMonth.rows.filter((row) => !row.paid && row.dueDate <= todayIso()).length;

  const recent = data.transactions
    .filter((t) => !t.pending && !t.parent_transaction_id)
    .sort((a, b) => b.posted_date.localeCompare(a.posted_date))
    .slice(0, 6);

  host.innerHTML = `
    <div class="sh-hero">
      <div class="sh-label">Cash across checking & savings</div>
      <div class="sh-balance">${money(accounts.cash)}</div>
      <div class="sh-foot">
        <span><b>${money(accounts.checking)}</b> checking</span>
        ${accounts.savings ? `<span><b>${money(accounts.savings)}</b> savings</span>` : ''}
        ${accounts.owed ? `<span><b>${money(accounts.owed)}</b> on cards</span>` : ''}
      </div>
    </div>

    ${dueSoon ? `<div class="sh-attention"><b>${dueSoon} bill${dueSoon === 1 ? '' : 's'} still need attention.</b> Open Plan to see the due date, payment status and paycheck assignment.</div>` : ''}

    <div class="sh-card">
      <div class="sh-month-head">
        <div class="sh-month-title">Spent in ${monthLabel(month)}</div>
        <div class="sh-month-value">${money(budget.totals.spent)}</div>
        ${budget.totals.planned ? `<div class="sh-budget-line"><span>${money0(Math.max(0, budget.totals.remaining))} left in the monthly budget</span><span>${Math.round(budgetPct)}%</span></div><div class="sh-meter"><i style="width:${budgetPct}%"></i></div>` : '<div class="sh-row-sub" style="margin-top:5px">Set category budgets and this becomes your monthly progress.</div>'}
      </div>
      ${routeButton(
        'Bills & subscriptions',
        `${billMonth.totals.paidCount} paid · ${billMonth.totals.remainingCount} still due${nextDue ? ` · next ${dateLabel(nextDue.dueDate)}` : ''}`,
        billMonth.totals.remaining ? money0(billMonth.totals.remaining) + ' due' : 'Paid up',
        '▣',
        'bills',
      )}
      ${routeButton(
        'Budget',
        budget.totals.planned ? `${budget.totals.setCount} set by you · ${budget.totals.adaptiveCount} automatic` : 'Set monthly category targets',
        budget.totals.planned ? money0(budget.totals.planned) : 'Set up',
        '◫',
        'budget',
      )}
      ${routeButton(
        'Next payday',
        nextPayday ? `Expected ${dateLabel(nextPayday)} · Plan shows what that check needs to cover` : 'No reliable payday pattern yet',
        nextPayday ? dateLabel(nextPayday) : '—',
        '$',
        'bills',
      )}
    </div>

    <section class="sh-section">
      <div class="sh-section-head"><div class="sh-section-title">Accounts</div><button class="sh-link" data-home-route="connect">Manage</button></div>
      <div class="sh-list">${accounts.accounts.map((account) => `
        <div class="sh-row">
          <span class="sh-row-icon">${initial(account.institution || account.nickname)}</span>
          <span><div class="sh-row-title">${esc(account.nickname || account.institution || 'Account')}</div><div class="sh-row-sub">${esc(account.institution || '')}${account.mask ? ` · •••• ${esc(account.mask)}` : ''}</div></span>
          <span class="sh-row-value">${account.type === 'credit' ? money(Math.abs(account.amount)) : money(account.amount)}</span>
        </div>`).join('')}</div>
    </section>

    <section class="sh-section">
      <div class="sh-section-head"><div class="sh-section-title">Recent activity</div><button class="sh-link" data-home-route="transactions">See all</button></div>
      <div class="sh-list">${recent.map((txn) => {
        const image = logo(txn.payee, data.transactions);
        const incoming = Number(txn.amount) < 0;
        return `<div class="sh-row">
          <span class="sh-row-icon">${image ? `<img src="${esc(image)}" alt="" referrerpolicy="no-referrer" />` : initial(txn.payee)}</span>
          <span><div class="sh-row-title">${esc(txn.payee)}</div><div class="sh-row-sub">${dateLabel(txn.posted_date)} · ${esc(txn.is_transfer ? 'Transfer' : txn.is_income ? 'Income' : txn.category || 'Uncategorized')}</div></span>
          <span class="sh-row-value ${incoming ? 'income' : ''}">${incoming ? '+' : '−'}${money(Math.abs(txn.amount))}</span>
        </div>`;
      }).join('')}</div>
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
  for (const child of [...main.children]) {
    if (child !== host) child.hidden = true;
  }
  render(host, data);
}

async function run() {
  if (!dashboardActive()) {
    dataPromise = null;
    return;
  }
  if (running || document.querySelector('main [data-simple-home]')) return;
  running = true;
  try {
    ensureStyle();
    const data = await loadData();
    if (data && dashboardActive()) mount(data);
  } catch {
    // If live data cannot load, the original dashboard remains underneath.
  } finally {
    running = false;
  }
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    run();
  }, 0);
}

new MutationObserver(schedule).observe(document.getElementById('app') ?? document.body, { childList: true, subtree: true });
schedule();
