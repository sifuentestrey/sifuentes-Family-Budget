import { buildAdaptiveBudget, VARIABLE_ESSENTIAL_CATEGORIES } from '../src/engine/adaptive-budget.js';

let selectedMonth = null;
let editingCategory = null;
let dataPromise = null;
let running = false;
let scheduled = false;
let notice = null;

const ESSENTIAL = new Set([
  'Rent/Mortgage', 'Utilities', 'Internet/Phone', 'Insurance', 'Car Insurance',
  'Health Insurance', 'Car Payment', 'Childcare', 'Subscriptions', 'Groceries',
  'Gas', 'Pharmacy', 'Medical', 'Taxes',
]);

const money = (n) => Number(n || 0).toLocaleString('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0,
});
const moneyExact = (n) => Number(n || 0).toLocaleString('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

function localMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function ensureStyle() {
  if (document.getElementById('simple-budget-style')) return;
  const style = document.createElement('style');
  style.id = 'simple-budget-style';
  style.textContent = `
    [data-simple-budget]{display:block}
    [data-simple-budget] .sb-month{display:flex;align-items:center;justify-content:space-between;margin:0 2px 12px}
    [data-simple-budget] .sb-month strong{font-size:15px}
    [data-simple-budget] .sb-chevron{width:36px;height:36px;border:1px solid var(--border);border-radius:11px;background:var(--surface);color:var(--text);font:inherit;font-size:20px}
    [data-simple-budget] .sb-summary{background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:16px;box-shadow:var(--shadow-sm);margin-bottom:16px}
    [data-simple-budget] .sb-summary-label{font-size:12px;color:var(--muted);font-weight:750}
    [data-simple-budget] .sb-summary-value{font-size:32px;line-height:1.05;font-weight:850;letter-spacing:-.04em;margin-top:3px;font-variant-numeric:tabular-nums}
    [data-simple-budget] .sb-summary-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)}
    [data-simple-budget] .sb-summary-grid span{display:block;font-size:10px;color:var(--muted)}
    [data-simple-budget] .sb-summary-grid b{display:block;margin-top:2px;font-size:14px;font-variant-numeric:tabular-nums}
    [data-simple-budget] .sb-note{font-size:11.5px;line-height:1.45;color:var(--muted);margin:8px 3px 15px}
    [data-simple-budget] .sb-section{margin-top:18px}
    [data-simple-budget] .sb-section-head{display:flex;justify-content:space-between;align-items:flex-end;margin:0 3px 7px}
    [data-simple-budget] .sb-section-title{font-size:16px;font-weight:820;letter-spacing:-.025em}
    [data-simple-budget] .sb-section-sub{font-size:11px;color:var(--muted);margin-top:1px}
    [data-simple-budget] .sb-list{border:1px solid var(--border);border-radius:16px;background:var(--surface);overflow:hidden}
    [data-simple-budget] .sb-row{padding:13px 14px}
    [data-simple-budget] .sb-row+.sb-row{border-top:1px solid var(--border)}
    [data-simple-budget] .sb-row-top{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
    [data-simple-budget] .sb-name{font-size:14px;font-weight:790;min-width:0}
    [data-simple-budget] .sb-amount{font-size:13px;font-weight:800;white-space:nowrap;font-variant-numeric:tabular-nums}
    [data-simple-budget] .sb-meter{height:6px;border-radius:999px;background:var(--quiet-soft);overflow:hidden;margin-top:9px}
    [data-simple-budget] .sb-meter i{display:block;height:100%;background:var(--accent);border-radius:999px}
    [data-simple-budget] .sb-meter i.over{background:var(--negative)}
    [data-simple-budget] .sb-row-foot{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-top:7px}
    [data-simple-budget] .sb-meta{font-size:10.5px;line-height:1.4;color:var(--muted)}
    [data-simple-budget] .sb-edit{border:0;background:none;color:var(--accent);font:inherit;font-size:11px;font-weight:800;padding:0;white-space:nowrap}
    [data-simple-budget] .sb-form{display:flex;gap:7px;margin-top:10px;align-items:center}
    [data-simple-budget] .sb-form input{min-width:0;flex:1;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);color:var(--text);font:inherit;padding:9px 10px}
    [data-simple-budget] .sb-form button{border:1px solid var(--border);border-radius:10px;background:var(--surface-2);color:var(--text);font:inherit;font-size:11px;font-weight:800;padding:9px 10px}
    [data-simple-budget] .sb-form button.primary{background:var(--text);color:var(--surface);border-color:var(--text)}
    [data-simple-budget] .sb-plan-link{width:100%;margin-top:16px;border:1px solid var(--border);border-radius:14px;background:var(--surface);color:var(--text);padding:12px;font:inherit;font-size:12px;font-weight:800;text-align:left}
  `;
  document.head.appendChild(style);
}

function budgetViewActive() {
  return Boolean(document.querySelector('main .seg-btn[data-view="budget"].active'));
}

async function loadData(force = false) {
  if (force) dataPromise = null;
  if (!dataPromise) {
    dataPromise = Promise.all([
      import('./connect.js'),
      import('./budget-targets.js'),
    ]).then(async ([connect, budgetTargets]) => {
      const session = await connect.getSession();
      if (!session) return null;
      const [transactions, targets, householdId] = await Promise.all([
        connect.listTransactions(),
        budgetTargets.listBudgetTargets(),
        connect.ensureHousehold(),
      ]);
      return { connect, budgetTargets, transactions, targets, householdId };
    });
  }
  return dataPromise;
}

function availableMonths(transactions) {
  const months = new Set((transactions ?? []).map((t) => String(t.posted_date ?? '').slice(0, 7)).filter(Boolean));
  months.add(localMonth());
  return [...months].sort();
}

function rowHtml(row) {
  const planned = row.planned;
  const pct = planned ? Math.min(100, Math.max(0, row.spent / planned * 100)) : 0;
  const range = row.variable && row.typicalLow != null && row.typicalHigh != null
    ? `Usually ${money(row.typicalLow)}–${money(row.typicalHigh)}`
    : null;
  const source = row.source === 'set'
    ? 'Your household target'
    : row.source === 'adaptive'
      ? 'Automatic from recent spending'
      : 'No budget set yet';
  const status = planned == null
    ? source
    : row.over
      ? `${moneyExact(Math.abs(row.remaining))} over · ${source}`
      : `${moneyExact(row.remaining)} remaining · ${source}`;

  return `<div class="sb-row" data-budget-category="${esc(row.category)}">
    <div class="sb-row-top">
      <div class="sb-name">${esc(row.category)}</div>
      <div class="sb-amount">${moneyExact(row.spent)}${planned != null ? ` <span style="color:var(--muted);font-weight:650">of ${money(planned)}</span>` : ''}</div>
    </div>
    ${planned != null ? `<div class="sb-meter"><i class="${row.over ? 'over' : ''}" style="width:${pct}%"></i></div>` : ''}
    <div class="sb-row-foot">
      <div class="sb-meta">${[status, range].filter(Boolean).join(' · ')}</div>
      <button class="sb-edit" type="button" data-budget-edit="${esc(row.category)}">${editingCategory === row.category ? 'Cancel' : 'Edit'}</button>
    </div>
    ${editingCategory === row.category ? `<form class="sb-form" data-budget-form="${esc(row.category)}">
      <input name="amount" type="number" min="0" step="1" inputmode="decimal" value="${row.source === 'set' ? esc(row.planned) : ''}" placeholder="Monthly target" required />
      <button class="primary" type="submit">Save</button>
      ${row.source === 'set' ? '<button type="button" data-budget-auto>Use automatic</button>' : ''}
    </form>` : ''}
  </div>`;
}

function render(host, data) {
  const months = availableMonths(data.transactions);
  if (!selectedMonth || !months.includes(selectedMonth)) selectedMonth = months.at(-1) ?? localMonth();
  const model = buildAdaptiveBudget({ transactions: data.transactions, targets: data.targets, month: selectedMonth });
  const visible = model.rows.filter((row) => row.spent > 0 || row.planned != null);
  const essentials = visible.filter((row) => ESSENTIAL.has(row.category));
  const flexible = visible.filter((row) => !ESSENTIAL.has(row.category));
  const t = model.totals;
  const idx = months.indexOf(selectedMonth);

  const section = (title, sub, rows) => rows.length ? `<section class="sb-section">
    <div class="sb-section-head"><div><div class="sb-section-title">${title}</div><div class="sb-section-sub">${sub}</div></div></div>
    <div class="sb-list">${rows.map(rowHtml).join('')}</div>
  </section>` : '';

  host.innerHTML = `
    <div class="sb-month">
      <button class="sb-chevron" type="button" data-budget-month="-1" ${idx <= 0 ? 'disabled' : ''}>‹</button>
      <strong>${monthLabel(selectedMonth)}</strong>
      <button class="sb-chevron" type="button" data-budget-month="1" ${idx >= months.length - 1 ? 'disabled' : ''}>›</button>
    </div>
    ${notice ? `<div class="banner banner-good"><div class="banner-body">${esc(notice)}</div></div>` : ''}
    <div class="sb-summary">
      <div class="sb-summary-label">Monthly budget</div>
      <div class="sb-summary-value">${t.planned ? moneyExact(t.planned) : 'Set your categories'}</div>
      <div class="sb-summary-grid">
        <div><span>Spent</span><b>${moneyExact(t.spent)}</b></div>
        <div><span>Remaining</span><b style="color:${t.remaining < 0 ? 'var(--negative)' : 'inherit'}">${t.planned ? moneyExact(t.remaining) : '—'}</b></div>
        <div><span>Automatic</span><b>${t.adaptiveCount}</b></div>
      </div>
    </div>
    <div class="sb-note">Electricity, water, groceries and gas are not treated like rigid caps. Until you set your own target, the app uses your recent range and plans variable essentials near the upper end of normal.</div>
    ${section('Essentials', 'Bills and necessities that the household has to account for.', essentials)}
    ${section('Flexible spending', 'Categories you can adjust month to month.', flexible)}
    <button class="sb-plan-link" type="button" data-go-plan>Open Money Plan → see when these dollars are actually needed</button>
  `;

  host.querySelectorAll('[data-budget-month]').forEach((button) => button.addEventListener('click', () => {
    const next = idx + Number(button.dataset.budgetMonth);
    if (months[next]) selectedMonth = months[next];
    editingCategory = null;
    notice = null;
    render(host, data);
  }));

  host.querySelectorAll('[data-budget-edit]').forEach((button) => button.addEventListener('click', () => {
    editingCategory = editingCategory === button.dataset.budgetEdit ? null : button.dataset.budgetEdit;
    render(host, data);
  }));

  host.querySelectorAll('[data-budget-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const amount = Number(new FormData(form).get('amount'));
      if (!Number.isFinite(amount) || amount < 0) return;
      const category = form.dataset.budgetForm;
      await data.budgetTargets.saveBudgetTarget(data.householdId, category, amount);
      data.targets[category] = amount;
      editingCategory = null;
      notice = `${category} budget updated for the household.`;
      render(host, data);
    });
    form.querySelector('[data-budget-auto]')?.addEventListener('click', async () => {
      const category = form.dataset.budgetForm;
      await data.budgetTargets.clearBudgetTarget(data.householdId, category);
      delete data.targets[category];
      editingCategory = null;
      notice = `${category} is back to automatic.`;
      render(host, data);
    });
  });

  host.querySelector('[data-go-plan]')?.addEventListener('click', () => window.__familyBudgetRoute?.('bills'));
}

function mount(data) {
  const main = document.querySelector('main');
  if (!main || !budgetViewActive()) return;
  let host = main.querySelector('[data-simple-budget]');
  if (!host) {
    host = document.createElement('div');
    host.dataset.simpleBudget = '1';
    main.appendChild(host);
  }
  for (const child of [...main.children]) {
    if (child === host) continue;
    child.hidden = true;
  }
  render(host, data);
}

async function run() {
  if (running || !budgetViewActive()) return;
  running = true;
  try {
    ensureStyle();
    const data = await loadData();
    if (data && budgetViewActive()) mount(data);
  } catch {
    // The legacy Budget view remains underneath if this enhancement cannot load.
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
