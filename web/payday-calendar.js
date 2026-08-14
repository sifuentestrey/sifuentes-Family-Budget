/**
 * Payday overlay for the Bills calendar.
 *
 * Bills and paydays answer the same planning question: what leaves the account,
 * and when does the next check arrive to cover it? Keep the bill-center engine
 * focused on obligations; this small browser layer adds trusted income-stream
 * dates to the calendar and its day agenda.
 */
import { listTransactions } from './connect.js';
import { detectIncomeStreams } from '../src/engine/income.js';
import { buildPaydayEvents } from './payday-events.js';

const stateByCenter = new WeakMap();
let dataPromise = null;
let scheduled = false;
let running = false;

function money(value) {
  return Number(value || 0).toLocaleString('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function compactMoney(value) {
  const amount = Math.abs(Number(value || 0));
  if (amount >= 1000) {
    const scaled = amount / 1000;
    return `$${scaled.toFixed(scaled >= 10 ? 0 : 1).replace(/\.0$/, '')}k`;
  }
  return `$${Math.round(amount)}`;
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function selectedMonth(center) {
  const text = center.querySelector('.bill-month-nav strong')?.textContent.trim();
  if (!text) return null;
  const date = new Date(`${text} 1`);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function cadenceLabel(cadence) {
  return ({
    weekly: 'weekly',
    biweekly: 'every 2 weeks',
    semimonthly: 'twice a month',
    monthly: 'monthly',
  })[cadence] ?? cadence ?? 'recurring';
}

function ensureStyle() {
  if (document.getElementById('payday-calendar-style')) return;
  const style = document.createElement('style');
  style.id = 'payday-calendar-style';
  style.textContent = `
    #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .payday-calendar-mini {
      display:block;width:100%;min-width:0;border-radius:5px;padding:2px 1px;
      text-align:center;font-size:8.5px;font-weight:850;line-height:1.05;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      font-variant-numeric:tabular-nums;color:var(--positive);
    }
    #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .payday-calendar-mini.deposited {
      background:var(--positive-soft);
    }
    #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .payday-calendar-mini.expected {
      box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--positive) 60%,transparent);
      background:transparent;
    }
    #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .payday-agenda-item {
      display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 10px;
      margin-bottom:3px;padding:9px 7px;border-radius:10px;background:var(--positive-soft);
    }
    #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .payday-agenda-name {
      min-width:0;display:flex;align-items:center;gap:6px;font-size:12px;font-weight:800;
    }
    #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .payday-agenda-status {
      flex:0 0 auto;border-radius:999px;padding:3px 6px;font-size:8px;font-weight:850;
      letter-spacing:.05em;text-transform:uppercase;color:var(--positive);
      background:color-mix(in srgb,var(--positive) 13%,transparent);
    }
    #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .payday-agenda-amount {
      color:var(--positive);font-size:12px;font-weight:850;font-variant-numeric:tabular-nums;
    }
    #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .payday-agenda-meta {
      grid-column:1/-1;color:var(--text-2);font-size:10.5px;line-height:1.35;
    }
    @media(max-width:390px){
      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .payday-calendar-mini{font-size:7.5px}
    }
  `;
  document.head.appendChild(style);
}

async function loadIncome(force = false) {
  if (force) dataPromise = null;
  if (!dataPromise) {
    dataPromise = listTransactions().then((transactions) => ({
      transactions,
      streams: detectIncomeStreams(transactions),
    }));
  }
  return dataPromise;
}

function eventsForDay(center, day) {
  return (stateByCenter.get(center)?.events ?? []).filter(
    (event) => Number(event.date.slice(8, 10)) === Number(day),
  );
}

function renderPaydayAgenda(center, day) {
  const events = eventsForDay(center, day);
  const calendar = center.querySelector('.bill-calendar');
  if (!calendar) return;

  let agenda = calendar.querySelector('.bill-calendar-agenda');
  if (!agenda) {
    agenda = document.createElement('div');
    agenda.className = 'bill-calendar-agenda';
    calendar.appendChild(agenda);
  }
  agenda.querySelectorAll('.payday-agenda-item').forEach((node) => node.remove());
  if (!events.length) return;

  agenda.querySelector('.bill-agenda-empty')?.remove();
  const head = agenda.querySelector('.bill-calendar-agenda-head');
  const html = events.map((event) => {
    const deposited = event.status === 'deposited';
    const meta = deposited
      ? `Paycheck deposited · ${cadenceLabel(event.cadence)}`
      : `Expected payday · ${cadenceLabel(event.cadence)} · typical net about ${money(event.amount)}`;
    return `<div class="payday-agenda-item">
      <div class="payday-agenda-name"><span>Payday</span><span class="payday-agenda-status">${deposited ? 'deposited' : 'expected'}</span></div>
      <div class="payday-agenda-amount">${deposited ? `+${money(event.amount)}` : 'Payday'}</div>
      <div class="payday-agenda-meta">${esc(meta)}</div>
    </div>`;
  }).join('');

  if (head) head.insertAdjacentHTML('afterend', html);
  else agenda.insertAdjacentHTML('afterbegin', html);
}

function bindCell(center, cell, day) {
  if (cell.dataset.paydayBound === '1') return;
  const show = () => queueMicrotask(() => renderPaydayAgenda(center, day));
  cell.addEventListener('click', show);
  cell.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') queueMicrotask(show);
  });
  cell.dataset.paydayBound = '1';
}

async function decorateCenter(center) {
  const calendar = center.querySelector('.bill-calendar');
  const month = selectedMonth(center);
  if (!calendar || !month) return;

  const prior = stateByCenter.get(center);
  const force = prior?.calendar !== calendar;
  const { streams } = await loadIncome(force);
  const events = buildPaydayEvents(streams, month);
  const signature = `${month}|${events.map((event) => `${event.date}:${event.status}:${event.amount}:${event.payee}`).join('|')}`;

  if (prior?.calendar === calendar && prior.signature === signature
      && calendar.querySelectorAll('.payday-calendar-mini').length === events.length) return;

  stateByCenter.set(center, { calendar, month, events, signature });
  calendar.querySelectorAll('.payday-calendar-mini').forEach((node) => node.remove());

  for (const cell of center.querySelectorAll('.bill-day')) {
    const day = Number(cell.querySelector('.bill-day-num')?.textContent || 0);
    if (!day) continue;
    bindCell(center, cell, day);
    const dayEvents = events.filter((event) => Number(event.date.slice(8, 10)) === day);
    for (const event of dayEvents) {
      const mini = document.createElement('span');
      mini.className = `payday-calendar-mini ${event.status}`;
      mini.textContent = event.status === 'deposited' ? `+${compactMoney(event.amount)}` : 'PAYDAY';
      mini.title = event.status === 'deposited'
        ? `Paycheck deposited ${money(event.amount)}`
        : `Expected payday · ${cadenceLabel(event.cadence)}`;
      cell.appendChild(mini);
    }

    if (dayEvents.length) {
      const existing = cell.getAttribute('aria-label') || `Day ${day}`;
      const paydayText = dayEvents.some((event) => event.status === 'deposited')
        ? 'paycheck deposited'
        : 'expected payday';
      if (!existing.includes(paydayText)) cell.setAttribute('aria-label', `${existing}, ${paydayText}`);
    }
  }

  const selected = Number(center.dataset.selectedBillDay || 0);
  if (selected) queueMicrotask(() => renderPaydayAgenda(center, selected));
}

async function run() {
  if (running) return;
  running = true;
  try {
    ensureStyle();
    const center = document.querySelector('[data-bill-center]');
    if (center) await decorateCenter(center);
  } catch {
    // Paydays are additive context. A failure here must never break Bills.
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

new MutationObserver(schedule).observe(document.getElementById('app') ?? document.body, {
  childList: true,
  subtree: true,
});
schedule();
