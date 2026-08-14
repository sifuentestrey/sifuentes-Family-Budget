/**
 * Bills center presentation.
 *
 * app.js already owns navigation, alerts, add/review flows and the rest of the
 * product. This module only replaces the confusing top half of the Bills view
 * with one operational answer:
 *
 *   what has to be paid, what already cleared, and which paycheck covers next.
 *
 * It is loaded by budget-clarity.js only while Bills is visible, so the main
 * app stays small and this can be removed without touching the core shell.
 */

import { listBillsForCenter, updateBillPreferences } from './bills.js';
import { listTransactions } from './connect.js';
import { analyzeSubscriptions } from '../src/engine/subscriptions.js';
import { detectIncomeStreams } from '../src/engine/income.js';
import { planPaycheckCoverage } from '../src/engine/bill-paycheck-plan.js';
import {
  billPreferences,
  buildBillMonth,
  buildUpcomingObligations,
  matchingRecurringStream,
} from '../src/engine/bill-center.js';

let selectedMonth = new Date().toISOString().slice(0, 7);
let dataPromise = null;
let mounting = false;

const money = (n) => Number(n || 0).toLocaleString('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

function monthLabel(month) {
  return new Date(`${month}-01T00:00:00`).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric',
  });
}

function dateLabel(date) {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
  });
}

function moveMonth(month, delta) {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 7);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isBillsView() {
  return Boolean(document.querySelector('main .seg-btn[data-view="bills"].active'));
}

function ensureStyle() {
  if (document.getElementById('bill-center-style')) return;
  const style = document.createElement('style');
  style.id = 'bill-center-style';
  style.textContent = `
    [data-bill-center] { margin-top: 12px; }
    [data-bill-center] .bill-center-month {
      display:flex; align-items:center; justify-content:space-between; gap:12px;
      margin: 2px 2px 12px;
    }
    [data-bill-center] .bill-center-month strong { font-size:15px; }
    [data-bill-center] .bill-center-month button {
      width:38px; height:38px; border:0; border-radius:12px;
      background:var(--surface-2, rgba(255,255,255,.06)); color:var(--text);
      font-size:22px; line-height:1; cursor:pointer;
    }
    [data-bill-center] .bill-progress {
      height:7px; border-radius:999px; overflow:hidden; margin-top:12px;
      background:rgba(255,255,255,.12);
    }
    [data-bill-center] .bill-progress > i {
      display:block; height:100%; border-radius:inherit; background:var(--positive);
    }
    [data-bill-center] .bill-center-group { margin-top:14px; }
    [data-bill-center] .bill-center-group:first-child { margin-top:0; }
    [data-bill-center] .bill-center-group-head {
      display:flex; align-items:baseline; justify-content:space-between; gap:12px;
      padding:0 4px 7px;
    }
    [data-bill-center] .bill-center-group-head strong { font-size:14px; }
    [data-bill-center] .bill-center-group-total { font-weight:700; }
    [data-bill-center] .bill-center-row.paid { opacity:.74; }
    [data-bill-center] .bill-center-row .row-title .chip { margin-left:6px; }
    [data-bill-center] .bill-center-row .row-end { min-width:88px; }
    [data-bill-center] .bill-center-setup .bill-pref-row {
      padding:12px 0; border-top:1px solid var(--border, rgba(255,255,255,.08));
    }
    [data-bill-center] .bill-center-setup .bill-pref-row:first-child { border-top:0; }
    [data-bill-center] .bill-pref-title { font-weight:700; margin-bottom:7px; }
    [data-bill-center] .bill-pref-line {
      display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:7px;
    }
    [data-bill-center] .bill-pref-label { font-size:12px; color:var(--muted); }
    [data-bill-center] .bill-pref-buttons { display:flex; gap:6px; }
    [data-bill-center] .bill-pref-buttons button {
      border:1px solid var(--border); border-radius:999px; background:transparent;
      color:var(--muted); padding:5px 9px; font:inherit; font-size:12px; cursor:pointer;
    }
    [data-bill-center] .bill-pref-buttons button.active {
      color:var(--text); border-color:var(--accent); background:var(--accent-soft, rgba(80,130,255,.12));
    }
    [data-bill-center] .bill-center-loading {
      padding:22px 10px; text-align:center; color:var(--muted);
    }
  `;
  document.head.appendChild(style);
}

function hideLegacyTop(main) {
  // The old hero and paycheck section answer pieces of the same question this
  // center now answers together. Leaving them visible would make the redesign
  // more confusing than the screen it replaces.
  const firstHero = [...main.children].find((node) => node.classList?.contains('hero'));
  if (firstHero) firstHero.hidden = true;

  for (const section of main.querySelectorAll('.section')) {
    const title = section.querySelector('.section-title')?.textContent.trim();
    if (['Which check covers what', 'Bills by paycheck', 'Upcoming bills'].includes(title)) {
      section.hidden = true;
    }
  }
}

async function loadData(force = false) {
  if (force) dataPromise = null;
  if (!dataPromise) {
    dataPromise = Promise.all([listBillsForCenter(), listTransactions()]).then(([bills, transactions]) => {
      const recurringAnalysis = analyzeSubscriptions(transactions);
      const recurring = [
        ...(recurringAnalysis.bills ?? []),
        ...(recurringAnalysis.subscriptions ?? []),
      ];
      return {
        bills,
        transactions,
        recurring,
        incomeStreams: detectIncomeStreams(transactions),
      };
    });
  }
  return dataPromise;
}

function statusChips(item) {
  const chips = [];
  if (item.paid) chips.push('<span class="chip chip-ok">paid</span>');
  else chips.push('<span class="chip chip-outline">due</span>');

  if (item.kind === 'subscription') chips.push('<span class="chip">subscription</span>');
  if (item.paymentMode === 'auto') chips.push('<span class="chip">auto</span>');
  if (item.paymentMode === 'manual') chips.push('<span class="chip">you pay</span>');
  if (item.amountVaries) chips.push('<span class="chip chip-warn">varies</span>');
  return chips.join('');
}

function initialAvatar(name) {
  const initial = String(name || '?').trim().charAt(0).toUpperCase() || '?';
  return `<div class="row-avatar ghost">${esc(initial)}</div>`;
}

function renderObligationRow(item) {
  const amount = item.paid ? item.paidAmount : item.amountDue;
  const primaryDate = item.paid
    ? `Paid ${dateLabel(item.paidDate ?? item.dueDate)}`
    : `Due ${dateLabel(item.dueDate)}`;
  const amountSub = item.paid
    ? 'paid'
    : item.amountVaries ? 'estimate' : 'due';

  return `
    <div class="row bill-center-row ${item.paid ? 'paid' : ''}">
      ${initialAvatar(item.providerName)}
      <div class="row-body">
        <div class="row-title">${esc(item.providerName)}${statusChips(item)}</div>
        <div class="row-sub">${primaryDate} · ${esc(item.category ?? 'Other')}</div>
      </div>
      <div class="row-end">
        <div class="row-amount">${money(amount)}</div>
        <div class="row-amount-sub">${amountSub}</div>
      </div>
    </div>
  `;
}

function billGroup(label, amount, rows) {
  if (!rows.length) return '';
  return `
    <div class="bill-center-group">
      <div class="bill-center-group-head">
        <strong>${label}</strong>
        <span class="bill-center-group-total">${money(amount)}</span>
      </div>
      <div class="list">${rows.map(renderObligationRow).join('')}</div>
    </div>
  `;
}

function renderMonth(monthData) {
  const { rows, totals } = monthData;
  const dueRows = rows.filter((row) => !row.paid);
  const paidRows = rows.filter((row) => row.paid);
  const pct = totals.total > 0 ? Math.min(100, Math.round((totals.paid / totals.total) * 100)) : 0;

  return `
    <div class="bill-center-month">
      <button type="button" data-bill-month-step="-1" aria-label="Previous month">‹</button>
      <strong>${monthLabel(monthData.month)}</strong>
      <button type="button" data-bill-month-step="1" aria-label="Next month">›</button>
    </div>

    <div class="hero">
      <div class="hero-label">${monthLabel(monthData.month).replace(/ \d{4}$/, '')} bills</div>
      <div class="hero-value">${totals.remaining > 0 ? `${money(totals.remaining)} left` : 'Paid'}</div>
      <div class="hero-note">
        ${money(totals.paid)} paid of ${money(totals.total)} expected.
        ${totals.remainingCount
          ? ` ${totals.remainingCount} still ${totals.remainingCount === 1 ? 'needs' : 'need'} to be paid.`
          : ' Everything expected this month has cleared.'}
      </div>
      <div class="bill-progress"><i style="width:${pct}%"></i></div>
      <div class="hero-foot">
        <span><b>${totals.paidCount}</b> paid</span>
        <span><b>${totals.remainingCount}</b> still due</span>
      </div>
    </div>

    <section class="section">
      <div class="section-head">
        <div>
          <div class="section-title">This month</div>
          <div class="section-sub">Everything recurring that has to be covered — including subscriptions.</div>
        </div>
      </div>
      ${rows.length ? `
        ${billGroup('Still due', totals.remaining, dueRows)}
        ${billGroup('Paid', totals.paid, paidRows)}
      ` : `<div class="empty"><div class="empty-title">Nothing recurring here yet</div><div class="empty-body">No paid or expected recurring obligations were found for this month.</div></div>`}
    </section>
  `;
}

function renderPaycheckPlan(upcoming, incomeStreams) {
  const plan = planPaycheckCoverage(upcoming, incomeStreams, { asOf: todayIso() });
  const groups = plan.groups.filter((group) => group.bills.length).slice(0, 4);

  const group = (label, items, total) => `
    <div class="bill-center-group">
      <div class="bill-center-group-head">
        <strong>${label}</strong>
        <span class="bill-center-group-total">${money(total)}</span>
      </div>
      <div class="list">${items.map((item) => renderObligationRow({ ...item, paid: false })).join('')}</div>
    </div>
  `;

  if (!plan.dueNow.bills.length && !groups.length && !plan.later.bills.length) return '';

  return `
    <section class="section">
      <div class="section-head">
        <div>
          <div class="section-title">Next paychecks</div>
          <div class="section-sub">Only unpaid items — assigned to the latest paycheck before each due date.</div>
        </div>
      </div>

      ${plan.dueNow.bills.length
        ? group(
          incomeStreams.length ? 'Needs money already in the account' : 'Paycheck pattern still learning',
          plan.dueNow.bills,
          plan.dueNow.total,
        )
        : ''}

      ${groups.map((g) => group(
        `${dateLabel(g.paycheckDate)} paycheck`,
        g.bills,
        g.total,
      )).join('')}

      ${plan.later.bills.length ? `
        <details class="fold">
          <summary>${plan.later.bills.length} further out · ${money(plan.later.total)}</summary>
          <div class="fold-body list">${plan.later.bills.map((item) => renderObligationRow({ ...item, paid: false })).join('')}</div>
        </details>` : ''}
    </section>
  `;
}

function renderPaymentSetup(bills, recurring) {
  if (!bills.length) return '';

  const rows = bills.map((bill) => {
    const prefs = billPreferences(bill);
    const stream = matchingRecurringStream(bill, recurring);
    const inferredAmount = stream
      ? (stream.fixedPrice === false ? 'variable' : 'fixed')
      : null;
    const amountMode = prefs.amountMode ?? inferredAmount;

    return `
      <div class="bill-pref-row" data-bill-pref-row="${esc(bill.id)}">
        <div class="bill-pref-title">${esc(bill.providerName)}</div>
        <div class="bill-pref-line">
          <span class="bill-pref-label">How it gets paid</span>
          <span class="bill-pref-buttons">
            <button type="button" class="${prefs.paymentMode === 'auto' ? 'active' : ''}"
              data-bill-pref="paymentMode" data-bill-id="${esc(bill.id)}" data-value="auto">Automatic</button>
            <button type="button" class="${prefs.paymentMode === 'manual' ? 'active' : ''}"
              data-bill-pref="paymentMode" data-bill-id="${esc(bill.id)}" data-value="manual">We pay it</button>
          </span>
        </div>
        <div class="bill-pref-line">
          <span class="bill-pref-label">Amount</span>
          <span class="bill-pref-buttons">
            <button type="button" class="${amountMode === 'fixed' ? 'active' : ''}"
              data-bill-pref="amountMode" data-bill-id="${esc(bill.id)}" data-value="fixed">Fixed</button>
            <button type="button" class="${amountMode === 'variable' ? 'active' : ''}"
              data-bill-pref="amountMode" data-bill-id="${esc(bill.id)}" data-value="variable">Varies</button>
          </span>
        </div>
      </div>
    `;
  }).join('');

  return `
    <details class="fold bill-center-setup">
      <summary>How these bills get paid</summary>
      <div class="fold-body">
        <div class="prose-sm" style="margin-bottom:6px;">
          Set automatic vs. “we pay it” once and both phones use it. Variable amounts can also be learned from the bank history.
        </div>
        ${rows}
      </div>
    </details>
  `;
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

  host.innerHTML = `
    ${renderMonth(monthData)}
    ${renderPaycheckPlan(upcoming, data.incomeStreams)}
    ${renderPaymentSetup(data.bills, data.recurring)}
  `;

  host.querySelectorAll('[data-bill-month-step]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedMonth = moveMonth(selectedMonth, Number(button.dataset.billMonthStep));
      renderCenter(host, data);
    });
  });

  host.querySelectorAll('[data-bill-pref]').forEach((button) => {
    button.addEventListener('click', async () => {
      const key = button.dataset.billPref;
      const id = button.dataset.billId;
      const value = button.dataset.value;
      button.disabled = true;
      try {
        await updateBillPreferences(id, { [key]: value });
        const fresh = await loadData(true);
        renderCenter(host, fresh);
      } catch (error) {
        button.disabled = false;
        const row = button.closest('[data-bill-pref-row]');
        if (row && !row.querySelector('.field-hint')) {
          row.insertAdjacentHTML('beforeend', `<div class="field-hint" style="color:var(--negative);margin-top:6px;">${esc(error.message || 'Could not save that setting.')}</div>`);
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
    if (host.isConnected) {
      host.innerHTML = `
        <div class="banner banner-warn">
          <div class="banner-body"><strong>Could not build the bill summary.</strong><div>${esc(error.message || 'Try reloading the app.')}</div></div>
        </div>`;
    }
  } finally {
    mounting = false;
  }
}
