/**
 * Bills center: one place for what must be paid, what cleared, and which
 * paycheck covers what remains.
 */
import {
  createBill,
  listBillsForCenter,
  updateBillDetails,
  updateBillPreferences,
} from './bills.js';
import { listTransactions } from './connect.js';
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

let selectedMonth = new Date().toISOString().slice(0, 7);
let dataPromise = null;
let mounting = false;
let editingKey = null;

const money = (n) => Number(n || 0).toLocaleString('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

function monthLabel(month) {
  return new Date(`${month}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
function dateLabel(date) {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function moveMonth(month, delta) {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 7);
}
function todayIso() { return new Date().toISOString().slice(0, 10); }
function currentMonth() { return todayIso().slice(0, 7); }
function isBillsView() { return Boolean(document.querySelector('main .seg-btn[data-view="bills"].active')); }

function ensureStyle() {
  if (document.getElementById('bill-center-style')) return;
  const style = document.createElement('style');
  style.id = 'bill-center-style';
  style.textContent = `
    [data-bill-center]{margin-top:12px}
    [data-bill-center] .bill-center-month{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:2px 2px 12px}
    [data-bill-center] .bill-center-month strong{font-size:15px}
    [data-bill-center] .bill-center-month button{width:38px;height:38px;border:0;border-radius:12px;background:var(--surface-2,rgba(255,255,255,.06));color:var(--text);font-size:22px;cursor:pointer}
    [data-bill-center] .bill-progress{height:7px;border-radius:999px;overflow:hidden;margin-top:12px;background:rgba(255,255,255,.12)}
    [data-bill-center] .bill-progress>i{display:block;height:100%;border-radius:inherit;background:var(--positive)}
    [data-bill-center] .bill-center-group{margin-top:14px}
    [data-bill-center] .bill-center-group-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:0 4px 7px}
    [data-bill-center] .bill-center-group-head strong{font-size:14px}
    [data-bill-center] .bill-center-row.paid{opacity:.8}
    [data-bill-center] .bill-center-row .row-title .chip{margin-left:6px}
    [data-bill-center] .bill-center-row .row-end{min-width:88px}
    [data-bill-center] .bill-center-loading{padding:22px 10px;text-align:center;color:var(--muted)}
    [data-bill-center] .bill-row-edit{border:0;background:transparent;color:var(--accent);font:inherit;font-size:12px;font-weight:700;padding:4px 0 0;cursor:pointer}
    [data-bill-center] .bill-edit-card{margin:0 0 8px;padding:12px;border:1px solid var(--border);border-radius:14px;background:var(--surface-2,rgba(255,255,255,.05))}
    [data-bill-center] .bill-edit-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}
    [data-bill-center] .bill-edit-grid label:first-child,[data-bill-center] .bill-edit-grid label:last-child{grid-column:1/-1}
    [data-bill-center] .bill-edit-grid label{font-size:11px;color:var(--muted);display:grid;gap:5px}
    [data-bill-center] .bill-edit-grid input{width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--text);padding:10px;font:inherit;font-size:14px}
    [data-bill-center] .bill-edit-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
    [data-bill-center] .bill-edit-actions button{border:1px solid var(--border);border-radius:10px;background:transparent;color:var(--text);padding:8px 12px;font:inherit;font-weight:700;cursor:pointer}
    [data-bill-center] .bill-edit-actions button[type="submit"]{background:var(--text);color:var(--surface);border-color:var(--text)}
    [data-bill-center] .bill-pref-row{padding:12px 0;border-top:1px solid var(--border,rgba(255,255,255,.08))}
    [data-bill-center] .bill-pref-row:first-child{border-top:0}
    [data-bill-center] .bill-pref-title{font-weight:700;margin-bottom:7px}
    [data-bill-center] .bill-pref-line{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:7px}
    [data-bill-center] .bill-pref-label{font-size:12px;color:var(--muted)}
    [data-bill-center] .bill-pref-buttons{display:flex;gap:6px}
    [data-bill-center] .bill-pref-buttons button{border:1px solid var(--border);border-radius:999px;background:transparent;color:var(--muted);padding:5px 9px;font:inherit;font-size:12px;cursor:pointer}
    [data-bill-center] .bill-pref-buttons button.active{color:var(--text);border-color:var(--accent);background:var(--accent-soft,rgba(80,130,255,.12))}
    @media(max-width:520px){[data-bill-center] .bill-edit-grid{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
}

function hideLegacyTop(main) {
  const firstHero = [...main.children].find((node) => node.classList?.contains('hero'));
  if (firstHero) firstHero.hidden = true;
  for (const section of main.querySelectorAll('.section')) {
    const title = section.querySelector('.section-title')?.textContent.trim();
    if (['Which check covers what', 'Bills by paycheck', 'Upcoming bills'].includes(title)) section.hidden = true;
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

async function loadData(force = false) {
  if (force) dataPromise = null;
  if (!dataPromise) {
    dataPromise = Promise.all([listBillsForCenter(), listTransactions()]).then(([rawBills, transactions]) => {
      const recurringAnalysis = analyzeSubscriptions(transactions);
      const recurring = [
        ...(recurringAnalysis.bills ?? []),
        ...buildReliableSubscriptionStreams(transactions),
      ];
      return {
        bills: dedupeTrackedBills(rawBills),
        transactions,
        recurring,
        incomeStreams: detectIncomeStreams(transactions),
      };
    });
  }
  return dataPromise;
}

function showLogos() { return localStorage.getItem('showLogos') !== '0'; }

// Plaid does not return merchant metadata for several ACH billers in this
// household. These are verified first-party domains, not domains guessed from
// a merchant name. Keep this deliberately small: an initial is better than the
// wrong company's logo.
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

function renderEditForm(item, bills) {
  if (editingKey !== item.id) return '';
  const tracked = trackedBillFor(item, bills);
  const source = tracked ?? item;
  return `
    <form class="bill-edit-card" data-bill-edit-form data-item-id="${esc(item.id)}" data-tracked-id="${esc(tracked?.id ?? '')}">
      <div class="bill-edit-grid">
        <label>Bill name<input name="providerName" required value="${esc(source.providerName)}" /></label>
        <label>Amount<input name="amountDue" type="number" inputmode="decimal" min="0" step="0.01" required value="${esc(Number(source.amountDue || 0).toFixed(2))}" /></label>
        <label>Due date<input name="dueDate" type="date" required value="${esc(source.dueDate)}" /></label>
        <label>Category<input name="category" required value="${esc(source.category ?? 'Other')}" /></label>
      </div>
      ${tracked ? '' : '<div class="field-hint" style="margin-top:8px">Saving turns this bank-detected item into a bill you control.</div>'}
      <div class="bill-edit-actions">
        <button type="button" data-bill-edit-cancel>Cancel</button>
        <button type="submit">Save</button>
      </div>
    </form>`;
}

function renderObligationRow(item, transactions, bills) {
  const amount = item.paid ? item.paidAmount : item.amountDue;
  const primaryDate = item.paid ? `Paid ${dateLabel(item.paidDate ?? item.dueDate)}` : `Due ${dateLabel(item.dueDate)}`;
  const merged = item.occurrenceCount > 1 ? ` · ${item.occurrenceCount} charges` : '';
  return `
    <div class="row bill-center-row ${item.paid ? 'paid' : ''}">
      ${avatar(item.providerName, transactions)}
      <div class="row-body">
        <div class="row-title">${esc(item.providerName)}${statusChips(item)}</div>
        <div class="row-sub">${primaryDate}${merged} · ${esc(item.category ?? 'Other')}</div>
      </div>
      <div class="row-end">
        <div class="row-amount">${money(amount)}</div>
        <div class="row-amount-sub">${item.paid ? 'paid' : item.amountVaries ? 'estimate' : 'due'}</div>
        <button type="button" class="bill-row-edit" data-bill-edit="${esc(item.id)}">Edit</button>
      </div>
    </div>
    ${renderEditForm(item, bills)}`;
}

function renderMonth(monthData, transactions, bills, showDue) {
  const due = monthData.rows.filter((r) => !r.paid);
  const paid = monthData.rows.filter((r) => r.paid);
  const t = monthData.totals;
  const pct = t.total > 0 ? Math.min(100, Math.round((t.paid / t.total) * 100)) : 0;
  const list = (items) => items.length
    ? `<div class="list">${items.map((item) => renderObligationRow(item, transactions, bills)).join('')}</div>`
    : '<div class="empty"><div class="empty-title">Nothing here</div></div>';
  const paidOpen = paid.some((item) => item.id === editingKey) ? ' open' : '';

  return `
    <div class="bill-center-month">
      <button type="button" data-bill-month-step="-1" aria-label="Previous month">‹</button>
      <strong>${monthLabel(monthData.month)}</strong>
      <button type="button" data-bill-month-step="1" aria-label="Next month">›</button>
    </div>
    <div class="hero">
      <div class="hero-label">${monthLabel(monthData.month).replace(/ \d{4}$/, '')} bills</div>
      <div class="hero-value">${t.remaining > 0 ? `${money(t.remaining)} left` : 'Paid'}</div>
      <div class="hero-note">${money(t.paid)} paid of ${money(t.total)} expected.</div>
      <div class="bill-progress"><i style="width:${pct}%"></i></div>
      <div class="hero-foot"><span><b>${t.paidCount}</b> paid</span><span><b>${t.remainingCount}</b> still due</span></div>
    </div>
    ${showDue ? `<section class="section"><div class="section-head"><div><div class="section-title">Expected this month</div><div class="section-sub">Unpaid items for the month you selected.</div></div></div>${list(due)}</section>` : ''}
    ${paid.length ? `<details class="fold bill-paid-history"${paidOpen}><summary>${paid.length} paid this month · ${money(t.paid)}</summary><div class="fold-body">${list(paid)}</div></details>` : ''}`;
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

function renderPaycheckPlan(upcoming, incomeStreams, transactions, bills) {
  const uniqueUpcoming = dedupeUpcoming(upcoming, bills);
  const plan = planPaycheckCoverage(uniqueUpcoming, incomeStreams, { asOf: todayIso() });
  const groups = plan.groups.filter((g) => g.bills.length).slice(0, 4);
  const group = (label, items, total) => `
    <div class="bill-center-group"><div class="bill-center-group-head"><strong>${label}</strong><span>${money(total)}</span></div>
      <div class="list">${items.map((item) => renderObligationRow({ ...item, paid: false }, transactions, bills)).join('')}</div></div>`;
  if (!plan.dueNow.bills.length && !groups.length && !plan.later.bills.length) return '';
  return `<section class="section"><div class="section-head"><div><div class="section-title">Next paychecks</div><div class="section-sub">One row per bill. Tap Edit whenever the bank gets something wrong.</div></div></div>
    ${plan.dueNow.bills.length ? group(incomeStreams.length ? 'Needs money already in the account' : 'Paycheck pattern still learning', plan.dueNow.bills, plan.dueNow.total) : ''}
    ${groups.map((g) => group(`${dateLabel(g.paycheckDate)} paycheck`, g.bills, g.total)).join('')}
    ${plan.later.bills.length ? `<details class="fold"><summary>${plan.later.bills.length} further out · ${money(plan.later.total)}</summary><div class="fold-body list">${plan.later.bills.map((item) => renderObligationRow({ ...item, paid: false }, transactions, bills)).join('')}</div></details>` : ''}
  </section>`;
}

function renderPaymentSetup(bills, recurring) {
  if (!bills.length) return '';
  const rows = bills.map((bill) => {
    const prefs = billPreferences(bill);
    const stream = matchingRecurringStream(bill, recurring);
    const amountMode = prefs.amountMode ?? (stream ? (stream.fixedPrice === false ? 'variable' : 'fixed') : null);
    return `<div class="bill-pref-row" data-bill-pref-row="${esc(bill.id)}">
      <div class="bill-pref-title">${esc(bill.providerName)}</div>
      <div class="bill-pref-line"><span class="bill-pref-label">How it gets paid</span><span class="bill-pref-buttons">
        <button type="button" class="${prefs.paymentMode === 'auto' ? 'active' : ''}" data-bill-pref="paymentMode" data-bill-id="${esc(bill.id)}" data-value="auto">Automatic</button>
        <button type="button" class="${prefs.paymentMode === 'manual' ? 'active' : ''}" data-bill-pref="paymentMode" data-bill-id="${esc(bill.id)}" data-value="manual">We pay it</button></span></div>
      <div class="bill-pref-line"><span class="bill-pref-label">Amount</span><span class="bill-pref-buttons">
        <button type="button" class="${amountMode === 'fixed' ? 'active' : ''}" data-bill-pref="amountMode" data-bill-id="${esc(bill.id)}" data-value="fixed">Fixed</button>
        <button type="button" class="${amountMode === 'variable' ? 'active' : ''}" data-bill-pref="amountMode" data-bill-id="${esc(bill.id)}" data-value="variable">Varies</button></span></div>
    </div>`;
  }).join('');
  return `<details class="fold"><summary>Bill settings</summary><div class="fold-body"><div class="prose-sm" style="margin-bottom:6px">Automatic/manual and fixed/variable are shared for the household.</div>${rows}</div></details>`;
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
  const isCurrent = selectedMonth === currentMonth();

  host.innerHTML = `
    ${renderMonth(monthData, data.transactions, data.bills, !isCurrent)}
    ${isCurrent ? renderPaycheckPlan(upcoming, data.incomeStreams, data.transactions, data.bills) : ''}
    ${renderPaymentSetup(data.bills, data.recurring)}
  `;

  host.querySelectorAll('[data-bill-month-step]').forEach((button) => button.addEventListener('click', () => {
    selectedMonth = moveMonth(selectedMonth, Number(button.dataset.billMonthStep));
    editingKey = null;
    renderCenter(host, data);
  }));

  host.querySelectorAll('[data-bill-edit]').forEach((button) => button.addEventListener('click', () => {
    editingKey = button.dataset.billEdit;
    renderCenter(host, data);
  }));

  host.querySelectorAll('[data-bill-edit-cancel]').forEach((button) => button.addEventListener('click', () => {
    editingKey = null;
    renderCenter(host, data);
  }));

  host.querySelectorAll('[data-bill-edit-form]').forEach((form) => form.addEventListener('submit', async (event) => {
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
      if (form.dataset.trackedId) await updateBillDetails(form.dataset.trackedId, details);
      else await createBill({ ...details, source: 'manual' });
      editingKey = null;
      renderCenter(host, await loadData(true));
    } catch (error) {
      save.disabled = false;
      if (!form.querySelector('.field-hint.error')) {
        form.insertAdjacentHTML('beforeend', `<div class="field-hint error" style="color:var(--negative);margin-top:8px">${esc(error.message || 'Could not save that bill.')}</div>`);
      }
    }
  }));

  host.querySelectorAll('[data-bill-pref]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await updateBillPreferences(button.dataset.billId, { [button.dataset.billPref]: button.dataset.value });
      renderCenter(host, await loadData(true));
    } catch (error) {
      button.disabled = false;
      const row = button.closest('[data-bill-pref-row]');
      if (row && !row.querySelector('.field-hint')) row.insertAdjacentHTML('beforeend', `<div class="field-hint" style="color:var(--negative);margin-top:6px">${esc(error.message || 'Could not save that setting.')}</div>`);
    }
  }));
}

/** Called after app.js renders the Bills view. Safe to call repeatedly. */
export async function enhanceBillsView() {
  if (!isBillsView() || mounting) return;
  const main = document.querySelector('main');
  const seg = main?.querySelector('.seg');
  if (!main || !seg) return;
  ensureStyle();
  hideLegacyTop(main);
  if (main.querySelector('[data-bill-center]')) return;

  const host = document.createElement('div');
  host.dataset.billCenter = '1';
  host.innerHTML = '<div class="bill-center-loading">Putting this month and the next paychecks together…</div>';
  seg.insertAdjacentElement('afterend', host);
  mounting = true;
  try {
    const data = await loadData();
    if (!host.isConnected || !isBillsView()) return;
    renderCenter(host, data);
    hideLegacyTop(main);
  } catch (error) {
    if (host.isConnected) host.innerHTML = `<div class="banner banner-warn"><div class="banner-body"><strong>Could not build the bill summary.</strong><div>${esc(error.message || 'Try reloading the app.')}</div></div></div>`;
  } finally {
    mounting = false;
  }
}
