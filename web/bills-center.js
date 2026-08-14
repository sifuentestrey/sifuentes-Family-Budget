/**
 * Bills center: one place for what must be paid, what already cleared, and
 * which paycheck covers each remaining obligation.
 *
 * This intentionally owns the Bills screen. The older view grew several
 * separate lists (tracked bills, detected charges, paycheck groups, paid
 * history) that could all show the same provider. A household should never
 * have to mentally dedupe its own budget.
 */
import {
  createBill,
  listBillSuppressions,
  listBillsForCenter,
  suppressBill,
  updateBillDetails,
  updateBillPreferences,
} from './bills.js';
import { listTransactions } from './connect.js';
import { requestTransactionSync } from './refresh-transactions.js';
import { analyzeSubscriptions } from '../src/engine/subscriptions.js';
import { buildReliableSubscriptionStreams } from '../src/engine/reliable-subscriptions.js';
import { detectIncomeStreams } from '../src/engine/income.js';
import { planPaycheckCoverage } from '../src/engine/bill-paycheck-plan.js';
import {
  billPreferences,
  buildBillMonth,
  buildUpcomingObligations,
  matchingRecurringStream,
  obligationProvidersMatch,
} from '../src/engine/bill-center.js';
import { providersMatch } from '../src/domain/provider-match.js';
import { domainForPayee, logoSources } from '../src/engine/merchant-domain.js';

function localIsoDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

let selectedMonth = localIsoDate().slice(0, 7);
let dataPromise = null;
let mounting = false;
let editingKey = null;
let addingBill = false;
let syncBusy = false;
let notice = null;

const money = (n) => Number(n || 0).toLocaleString('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

function monthLabel(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(year, monthNumber - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
function dateLabel(date) {
  if (!date) return '';
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function moveMonth(month, delta) {
  const [year, monthNumber] = month.split('-').map(Number);
  const d = new Date(year, monthNumber - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function todayIso() { return localIsoDate(); }
function currentMonth() { return todayIso().slice(0, 7); }
function isBillsView() { return Boolean(document.querySelector('main .seg-btn[data-view="bills"].active')); }

function ensureStyle() {
  if (document.getElementById('bill-center-style')) return;
  const style = document.createElement('style');
  style.id = 'bill-center-style';
  style.textContent = `
    [data-bill-center]{margin-top:8px}
    [data-bill-center] .bill-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:2px 2px 10px}
    [data-bill-center] .bill-month-nav{display:flex;align-items:center;gap:6px}
    [data-bill-center] .bill-month-nav strong{min-width:126px;text-align:center;font-size:15px}
    [data-bill-center] .bill-icon-btn{width:36px;height:36px;border:1px solid var(--border);border-radius:11px;background:var(--surface);color:var(--text);font:inherit;font-size:20px;cursor:pointer}
    [data-bill-center] .bill-toolbar-actions{display:flex;gap:6px}
    [data-bill-center] .bill-text-btn{min-height:36px;border:1px solid var(--border);border-radius:11px;background:var(--surface);color:var(--text);font:inherit;font-size:12px;font-weight:750;padding:0 10px;cursor:pointer}
    [data-bill-center] .bill-text-btn:disabled{opacity:.55;cursor:default}
    [data-bill-center] .bill-month-meta{display:flex;gap:8px;flex-wrap:wrap;margin:0 3px 12px;color:var(--muted);font-size:12px}
    [data-bill-center] .bill-month-meta span{padding:5px 8px;border-radius:999px;background:var(--surface-2,rgba(255,255,255,.05))}
    [data-bill-center] .bill-calendar{border:1px solid var(--border);border-radius:16px;background:var(--surface);padding:10px;margin-bottom:16px}
    [data-bill-center] .bill-calendar-weekdays,[data-bill-center] .bill-calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}
    [data-bill-center] .bill-calendar-weekdays span{text-align:center;color:var(--muted);font-size:10px;font-weight:700;padding:2px 0 5px}
    [data-bill-center] .bill-day{min-height:46px;border-radius:10px;padding:5px 4px;display:flex;flex-direction:column;align-items:center;gap:4px;font-size:11px}
    [data-bill-center] .bill-day.today{outline:1px solid var(--accent)}
    [data-bill-center] .bill-day.has-items{background:var(--surface-2,rgba(255,255,255,.05))}
    [data-bill-center] .bill-day-num{font-weight:750}
    [data-bill-center] .bill-day-dots{display:flex;gap:3px;justify-content:center;flex-wrap:wrap}
    [data-bill-center] .bill-day-dot{width:5px;height:5px;border-radius:999px;background:var(--accent)}
    [data-bill-center] .bill-day-dot.paid{background:var(--positive)}
    [data-bill-center] .bill-day-count{font-size:9px;color:var(--muted)}
    [data-bill-center] .bill-center-row.paid{opacity:.78}
    [data-bill-center] .bill-center-row .row-title .chip{margin-left:6px}
    [data-bill-center] .bill-center-row .row-end{min-width:88px}
    [data-bill-center] .bill-center-loading{padding:22px 10px;text-align:center;color:var(--muted)}
    [data-bill-center] .bill-row-edit{border:0;background:transparent;color:var(--accent);font:inherit;font-size:12px;font-weight:750;padding:4px 0 0;cursor:pointer}
    [data-bill-center] .bill-edit-card{margin:0 0 8px;padding:12px;border:1px solid var(--border);border-radius:14px;background:var(--surface-2,rgba(255,255,255,.05))}
    [data-bill-center] .bill-edit-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}
    [data-bill-center] .bill-edit-grid .wide{grid-column:1/-1}
    [data-bill-center] .bill-edit-grid label{font-size:11px;color:var(--muted);display:grid;gap:5px}
    [data-bill-center] .bill-edit-grid input,[data-bill-center] .bill-edit-grid select{width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--text);padding:10px;font:inherit;font-size:14px}
    [data-bill-center] .bill-edit-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:10px}
    [data-bill-center] .bill-edit-actions button{border:1px solid var(--border);border-radius:10px;background:transparent;color:var(--text);padding:8px 12px;font:inherit;font-weight:750;cursor:pointer}
    [data-bill-center] .bill-edit-actions button[type="submit"]{background:var(--text);color:var(--surface);border-color:var(--text)}
    [data-bill-center] .bill-edit-actions .danger{color:var(--negative);margin-right:auto}
    [data-bill-center] .bill-add-card{margin-bottom:14px}
    [data-bill-center] .bill-notice{margin:0 0 10px;padding:9px 11px;border-radius:11px;background:var(--surface-2,rgba(255,255,255,.05));color:var(--muted);font-size:12px}
    @media(max-width:520px){
      [data-bill-center] .bill-toolbar{align-items:flex-start}
      [data-bill-center] .bill-toolbar-actions{flex-direction:column}
      [data-bill-center] .bill-edit-grid{grid-template-columns:1fr}
      [data-bill-center] .bill-edit-grid .wide{grid-column:auto}
      [data-bill-center] .bill-day{min-height:42px;padding:4px 2px}
    }
  `;
  document.head.appendChild(style);
}

/** Hide the old duplicate Bills implementation; this center owns the screen. */
function hideLegacy(main, host = null) {
  const seg = [...main.children].find((node) => node.classList?.contains('seg'));
  for (const child of [...main.children]) {
    if (child === seg || child === host) continue;
    child.hidden = true;
  }
}

function dedupeTrackedBills(bills) {
  const out = [];
  for (const bill of bills) {
    const duplicate = out.find((existing) =>
      existing.dueDate === bill.dueDate
      && Math.abs(existing.amountDue - bill.amountDue) < 0.01
      && existing.category === bill.category
      && obligationProvidersMatch(existing.providerName, bill.providerName),
    );
    if (!duplicate) out.push(bill);
    else if (bill.providerName.length < duplicate.providerName.length) out[out.indexOf(duplicate)] = bill;
  }
  return out;
}

function suppressedProvider(name, suppressions) {
  return suppressions.some((marker) => obligationProvidersMatch(marker.providerName, name));
}

async function loadData(force = false) {
  if (force) dataPromise = null;
  if (!dataPromise) {
    dataPromise = Promise.all([
      listBillsForCenter(),
      listBillSuppressions(),
      listTransactions(),
    ]).then(([rawBills, suppressions, transactions]) => {
      const recurringAnalysis = analyzeSubscriptions(transactions);
      const recurring = [
        ...(recurringAnalysis.bills ?? []),
        ...buildReliableSubscriptionStreams(transactions, { asOf: todayIso() }),
      ].filter((stream) => !suppressedProvider(stream.payee, suppressions));

      return {
        bills: dedupeTrackedBills(rawBills)
          .filter((bill) => !suppressedProvider(bill.providerName, suppressions)),
        suppressions,
        transactions,
        recurring,
        incomeStreams: detectIncomeStreams(transactions),
      };
    });
  }
  return dataPromise;
}

function showLogos() { return localStorage.getItem('showLogos') !== '0'; }

const VERIFIED_BILL_DOMAINS = [
  [/pennymac/i, 'pennymac.com'],
  [/advancial/i, 'advancial.org'],
  [/trinity\s+valley|\btvec\b/i, 'tvec.net'],
];

function verifiedBillDomain(name) {
  return VERIFIED_BILL_DOMAINS.find(([pattern]) => pattern.test(String(name ?? '')))?.[1] ?? null;
}

function logoForPayee(name, transactions) {
  if (!showLogos() || !name) return [];
  const matches = (transactions ?? []).filter((t) => providersMatch(t.payee, name) || obligationProvidersMatch(t.payee, name));
  const plaidLogo = matches.find((t) => t.logo_url)?.logo_url ?? null;
  const website = matches.find((t) => t.merchant_website)?.merchant_website ?? null;
  const matchedName = matches[0]?.payee ?? name;
  return [...new Set([
    plaidLogo,
    ...logoSources(verifiedBillDomain(name)),
    ...logoSources(domainForPayee(name, website)),
    ...logoSources(domainForPayee(matchedName, website)),
  ].filter(Boolean))];
}

function avatar(name, transactions) {
  const label = String(name || '?').trim();
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  const letter = esc(label.charAt(0).toUpperCase() || '?');
  const sources = logoForPayee(label, transactions);
  if (!sources.length) return `<div class="row-avatar av-${hash % 6}">${letter}</div>`;
  const [first, ...rest] = sources;
  return `<span class="row-avatar av-${hash % 6} has-logo">${letter}<img
    src="${esc(first)}" alt="" loading="lazy" referrerpolicy="no-referrer"
    data-next="${esc(rest.join(' '))}"
    onload="this.classList.add('loaded')" onerror="window.__logoFailed(this)" /></span>`;
}

function statusChips(item) {
  const chips = [item.paid ? '<span class="chip chip-ok">paid</span>' : '<span class="chip chip-outline">due</span>'];
  if (item.kind === 'subscription') chips.push('<span class="chip">subscription</span>');
  if (item.paymentMode === 'auto') chips.push('<span class="chip">auto</span>');
  if (item.paymentMode === 'manual') chips.push('<span class="chip">you pay</span>');
  if (item.amountVaries) chips.push('<span class="chip chip-warn">varies</span>');
  return chips.join('');
}

function trackedBillFor(item, bills) {
  if (item.trackedBillId) {
    const exact = bills.find((bill) => bill.id === item.trackedBillId);
    if (exact) return exact;
  }
  const exactId = bills.find((bill) => bill.id === item.id);
  if (exactId) return exactId;
  return bills.find((bill) => obligationProvidersMatch(bill.providerName, item.providerName)) ?? null;
}

function modeOption(value, current, label) {
  return `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`;
}

function renderEditForm(item, bills) {
  if (editingKey !== item.id) return '';
  const tracked = trackedBillFor(item, bills);
  const source = tracked ?? item;
  const prefs = tracked ? billPreferences(tracked) : {};
  const paymentMode = prefs.paymentMode ?? item.paymentMode ?? '';
  const amountMode = prefs.amountMode ?? (item.amountVaries ? 'variable' : item.amountVaries === false ? 'fixed' : '');
  return `
    <form class="bill-edit-card" data-bill-edit-form data-item-id="${esc(item.id)}" data-tracked-id="${esc(tracked?.id ?? '')}">
      <div class="bill-edit-grid">
        <label class="wide">Bill name<input name="providerName" required value="${esc(source.providerName)}" /></label>
        <label>Amount<input name="amountDue" type="number" inputmode="decimal" min="0" step="0.01" required value="${esc(Number(source.amountDue || 0).toFixed(2))}" /></label>
        <label>Due date<input name="dueDate" type="date" required value="${esc(source.dueDate)}" /></label>
        <label>Payment<select name="paymentMode">
          ${modeOption('', paymentMode, 'Not set')}
          ${modeOption('auto', paymentMode, 'Automatic')}
          ${modeOption('manual', paymentMode, 'We pay it')}
        </select></label>
        <label>Amount type<select name="amountMode">
          ${modeOption('', amountMode, 'Not set')}
          ${modeOption('fixed', amountMode, 'Fixed')}
          ${modeOption('variable', amountMode, 'Varies')}
        </select></label>
        <label class="wide">Category<input name="category" required value="${esc(source.category ?? 'Other')}" /></label>
      </div>
      ${tracked ? '' : '<div class="field-hint" style="margin-top:8px">Saving turns this bank-detected item into a bill you control.</div>'}
      <div class="bill-edit-actions">
        <button type="button" class="danger" data-bill-delete>Delete</button>
        <button type="button" data-bill-edit-cancel>Cancel</button>
        <button type="submit">Save</button>
      </div>
    </form>`;
}

function renderAddForm() {
  if (!addingBill) return '';
  return `
    <form class="bill-edit-card bill-add-card" data-bill-add-form>
      <div class="bill-edit-grid">
        <label class="wide">Bill name<input name="providerName" required autocomplete="off" /></label>
        <label>Amount<input name="amountDue" type="number" inputmode="decimal" min="0" step="0.01" required /></label>
        <label>Due date<input name="dueDate" type="date" required value="${todayIso()}" /></label>
        <label>Payment<select name="paymentMode"><option value="">Not set</option><option value="auto">Automatic</option><option value="manual">We pay it</option></select></label>
        <label>Amount type<select name="amountMode"><option value="">Not set</option><option value="fixed">Fixed</option><option value="variable">Varies</option></select></label>
        <label class="wide">Category<input name="category" value="Other" required /></label>
      </div>
      <div class="bill-edit-actions">
        <button type="button" data-bill-add-cancel>Cancel</button>
        <button type="submit">Add bill</button>
      </div>
    </form>`;
}

function obligationMatch(a, b) {
  return a.dueDate === b.dueDate && obligationProvidersMatch(a.providerName, b.providerName);
}

function dedupeUpcoming(items, bills) {
  const out = [];
  for (const item of items) {
    const index = out.findIndex((existing) => obligationProvidersMatch(existing.providerName, item.providerName));
    if (index < 0) {
      out.push(item);
      continue;
    }
    const existingTracked = trackedBillFor(out[index], bills);
    const incomingTracked = trackedBillFor(item, bills);
    if (!existingTracked && incomingTracked) out[index] = item;
    else if (!existingTracked && !incomingTracked && item.dueDate < out[index].dueDate) out[index] = item;
  }
  return out;
}

function assignmentRecords(upcoming, incomeStreams, bills) {
  const plan = planPaycheckCoverage(dedupeUpcoming(upcoming, bills), incomeStreams, { asOf: todayIso() });
  const records = [];
  for (const bill of plan.dueNow.bills) records.push({ bill, label: 'Needs money already in the account' });
  for (const group of plan.groups) {
    for (const bill of group.bills) records.push({ bill, label: `${dateLabel(group.paycheckDate)} paycheck` });
  }
  for (const bill of plan.later.bills) records.push({ bill, label: 'Paycheck assignment later' });
  return records;
}

function assignmentFor(item, records) {
  return records.find((record) => obligationMatch(item, record.bill))?.label ?? null;
}

function renderObligationRow(item, transactions, bills, assignments) {
  const amount = item.paid ? item.paidAmount : item.amountDue;
  const primaryDate = item.paid ? `Paid ${dateLabel(item.paidDate ?? item.dueDate)}` : `Due ${dateLabel(item.dueDate)}`;
  const assignment = item.paid ? null : assignmentFor(item, assignments);
  const detail = [primaryDate, assignment, item.category ?? 'Other'].filter(Boolean).join(' · ');
  return `
    <div class="row bill-center-row ${item.paid ? 'paid' : ''}">
      ${avatar(item.providerName, transactions)}
      <div class="row-body">
        <div class="row-title">${esc(item.providerName)}${statusChips(item)}</div>
        <div class="row-sub">${esc(detail)}</div>
      </div>
      <div class="row-end">
        <div class="row-amount">${money(amount)}</div>
        <div class="row-amount-sub">${item.paid ? 'paid' : item.amountVaries ? 'estimate' : 'due'}</div>
        <button type="button" class="bill-row-edit" data-bill-edit="${esc(item.id)}">Edit</button>
      </div>
    </div>
    ${renderEditForm(item, bills)}`;
}

function renderCalendar(monthData) {
  const [year, monthNumber] = monthData.month.split('-').map(Number);
  const firstWeekday = new Date(year, monthNumber - 1, 1).getDay();
  const days = new Date(year, monthNumber, 0).getDate();
  const byDay = new Map();
  for (const item of monthData.rows) {
    const date = item.dueDate ?? item.paidDate;
    if (!date || date.slice(0, 7) !== monthData.month) continue;
    const day = Number(date.slice(8, 10));
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(item);
  }

  const cells = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push('<div></div>');
  for (let day = 1; day <= days; day += 1) {
    const items = byDay.get(day) ?? [];
    const iso = `${monthData.month}-${String(day).padStart(2, '0')}`;
    const dots = items.slice(0, 3).map((item) => `<i class="bill-day-dot ${item.paid ? 'paid' : ''}"></i>`).join('');
    cells.push(`<div class="bill-day ${items.length ? 'has-items' : ''} ${iso === todayIso() ? 'today' : ''}" title="${esc(items.map((x) => x.providerName).join(', '))}">
      <span class="bill-day-num">${day}</span>
      ${items.length ? `<span class="bill-day-dots">${dots}</span>${items.length > 3 ? `<span class="bill-day-count">+${items.length - 3}</span>` : ''}` : ''}
    </div>`);
  }

  return `<div class="bill-calendar">
    <div class="bill-calendar-weekdays">${['S','M','T','W','T','F','S'].map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="bill-calendar-grid">${cells.join('')}</div>
  </div>`;
}

function renderMonth(monthData, transactions, bills, assignments) {
  const rows = [...monthData.rows].sort((a, b) =>
    String(a.dueDate ?? a.paidDate).localeCompare(String(b.dueDate ?? b.paidDate))
      || a.providerName.localeCompare(b.providerName),
  );
  const list = rows.length
    ? `<div class="list">${rows.map((item) => renderObligationRow(item, transactions, bills, assignments)).join('')}</div>`
    : '<div class="empty"><div class="empty-title">No bills or subscriptions for this month</div><div class="empty-body">Add one if the bank has not seen it yet.</div></div>';
  const paidCount = rows.filter((item) => item.paid).length;
  const dueCount = rows.length - paidCount;

  return `
    <div class="bill-toolbar">
      <div class="bill-month-nav">
        <button class="bill-icon-btn" type="button" data-bill-month-step="-1" aria-label="Previous month">‹</button>
        <strong>${monthLabel(monthData.month)}</strong>
        <button class="bill-icon-btn" type="button" data-bill-month-step="1" aria-label="Next month">›</button>
      </div>
      <div class="bill-toolbar-actions">
        <button class="bill-text-btn" type="button" data-bill-sync ${syncBusy ? 'disabled' : ''}>${syncBusy ? 'Syncing…' : 'Sync'}</button>
        <button class="bill-text-btn" type="button" data-bill-add>${addingBill ? 'Close' : '+ Add'}</button>
      </div>
    </div>
    ${notice ? `<div class="bill-notice">${esc(notice)}</div>` : ''}
    ${renderAddForm()}
    <div class="bill-month-meta"><span>${paidCount} paid</span><span>${dueCount} coming up</span></div>
    ${renderCalendar(monthData)}
    <section class="section"><div class="section-head"><div><div class="section-title">Bills & subscriptions</div><div class="section-sub">Paid and upcoming, in date order. Automatic items are marked auto.</div></div></div>${list}</section>`;
}

function renderCenter(host, data) {
  const monthData = buildBillMonth({
    bills: data.bills,
    recurring: data.recurring,
    transactions: data.transactions,
    month: selectedMonth,
  });
  const upcoming = buildUpcomingObligations({
    bills: data.bills,
    recurring: data.recurring,
    transactions: data.transactions,
    asOf: todayIso(),
  });
  const assignments = assignmentRecords(upcoming, data.incomeStreams, data.bills);

  host.innerHTML = renderMonth(monthData, data.transactions, data.bills, assignments);

  host.querySelectorAll('[data-bill-month-step]').forEach((button) => button.addEventListener('click', () => {
    selectedMonth = moveMonth(selectedMonth, Number(button.dataset.billMonthStep));
    editingKey = null;
    notice = null;
    renderCenter(host, data);
  }));

  host.querySelector('[data-bill-add]')?.addEventListener('click', () => {
    addingBill = !addingBill;
    editingKey = null;
    renderCenter(host, data);
  });

  host.querySelector('[data-bill-add-cancel]')?.addEventListener('click', () => {
    addingBill = false;
    renderCenter(host, data);
  });

  host.querySelector('[data-bill-sync]')?.addEventListener('click', async () => {
    if (syncBusy) return;
    syncBusy = true;
    notice = null;
    renderCenter(host, data);
    try {
      const result = await requestTransactionSync();
      const changed = (result.synced ?? []).reduce((sum, item) => sum + Number(item.added ?? 0) + Number(item.modified ?? 0), 0);
      notice = changed ? `Bank sync finished — ${changed} transaction${changed === 1 ? '' : 's'} changed.` : 'Bank sync finished. Nothing new yet.';
      data = await loadData(true);
    } catch (error) {
      notice = error.message || 'Could not sync accounts.';
    } finally {
      syncBusy = false;
      renderCenter(host, data);
    }
  });

  host.querySelectorAll('[data-bill-edit]').forEach((button) => button.addEventListener('click', () => {
    editingKey = button.dataset.billEdit;
    addingBill = false;
    renderCenter(host, data);
  }));

  host.querySelectorAll('[data-bill-edit-cancel]').forEach((button) => button.addEventListener('click', () => {
    editingKey = null;
    renderCenter(host, data);
  }));

  host.querySelectorAll('[data-bill-add-form]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const save = form.querySelector('button[type="submit"]');
    save.disabled = true;
    const fields = new FormData(form);
    try {
      const id = await createBill({
        providerName: fields.get('providerName'),
        amountDue: Number(fields.get('amountDue')),
        dueDate: fields.get('dueDate'),
        category: fields.get('category'),
        source: 'manual',
      });
      const paymentMode = fields.get('paymentMode');
      const amountMode = fields.get('amountMode');
      if (paymentMode || amountMode) {
        await updateBillPreferences(id, {
          ...(paymentMode ? { paymentMode } : {}),
          ...(amountMode ? { amountMode } : {}),
        });
      }
      addingBill = false;
      notice = 'Bill added.';
      renderCenter(host, await loadData(true));
    } catch (error) {
      save.disabled = false;
      if (!form.querySelector('.field-hint.error')) {
        form.insertAdjacentHTML('beforeend', `<div class="field-hint error" style="color:var(--negative);margin-top:8px">${esc(error.message || 'Could not add that bill.')}</div>`);
      }
    }
  }));

  host.querySelectorAll('[data-bill-edit-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const save = form.querySelector('button[type="submit"]');
      save.disabled = true;
      const fields = new FormData(form);
      const details = {
        providerName: fields.get('providerName'),
        amountDue: fields.get('amountDue'),
        dueDate: fields.get('dueDate'),
        category: fields.get('category'),
      };
      try {
        const id = form.dataset.trackedId
          ? (await updateBillDetails(form.dataset.trackedId, details), form.dataset.trackedId)
          : await createBill({ ...details, amountDue: Number(details.amountDue), source: 'manual' });
        const paymentMode = fields.get('paymentMode');
        const amountMode = fields.get('amountMode');
        if (paymentMode || amountMode) {
          await updateBillPreferences(id, {
            ...(paymentMode ? { paymentMode } : {}),
            ...(amountMode ? { amountMode } : {}),
          });
        }
        editingKey = null;
        notice = 'Bill updated.';
        renderCenter(host, await loadData(true));
      } catch (error) {
        save.disabled = false;
        if (!form.querySelector('.field-hint.error')) {
          form.insertAdjacentHTML('beforeend', `<div class="field-hint error" style="color:var(--negative);margin-top:8px">${esc(error.message || 'Could not save that bill.')}</div>`);
        }
      }
    });

    form.querySelector('[data-bill-delete]')?.addEventListener('click', async () => {
      const fields = new FormData(form);
      const name = String(fields.get('providerName') || 'this bill');
      if (!window.confirm(`Delete ${name} from Bills? It will stop being projected from bank history until you add it again.`)) return;
      const button = form.querySelector('[data-bill-delete]');
      button.disabled = true;
      try {
        await suppressBill({
          id: form.dataset.trackedId || null,
          providerName: fields.get('providerName'),
          amountDue: Number(fields.get('amountDue')),
          dueDate: fields.get('dueDate'),
          category: fields.get('category'),
        });
        editingKey = null;
        notice = `${name} removed from Bills.`;
        renderCenter(host, await loadData(true));
      } catch (error) {
        button.disabled = false;
        if (!form.querySelector('.field-hint.error')) {
          form.insertAdjacentHTML('beforeend', `<div class="field-hint error" style="color:var(--negative);margin-top:8px">${esc(error.message || 'Could not delete that bill.')}</div>`);
        }
      }
    });
  });
}

/** Called after app.js renders the Bills view. Safe to call repeatedly. */
export async function enhanceBillsView() {
  if (!isBillsView() || mounting) return;
  const main = document.querySelector('main');
  const seg = main?.querySelector('.seg');
  if (!main || !seg) return;
  ensureStyle();
  const existing = main.querySelector('[data-bill-center]');
  if (existing) {
    hideLegacy(main, existing);
    return;
  }

  const host = document.createElement('div');
  host.dataset.billCenter = '1';
  host.innerHTML = '<div class="bill-center-loading">Checking bills and subscriptions…</div>';
  seg.insertAdjacentElement('afterend', host);
  hideLegacy(main, host);
  mounting = true;
  try {
    const data = await loadData();
    if (!host.isConnected || !isBillsView()) return;
    renderCenter(host, data);
    hideLegacy(main, host);
  } catch (error) {
    if (host.isConnected) host.innerHTML = `<div class="banner banner-warn"><div class="banner-body"><strong>Could not build Bills.</strong><div>${esc(error.message || 'Try reloading the app.')}</div></div></div>`;
  } finally {
    mounting = false;
  }
}
