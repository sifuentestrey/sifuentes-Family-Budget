/**
 * Family Budget web app.
 *
 * Mobile-first, no build step, no framework. Reads through Supabase with RLS,
 * so the browser can only ever see this household's rows.
 *
 * Runs against fixtures when no Supabase config is present, so the UI is
 * reviewable without a database or a bank connection.
 */

import { normalizePlaidTransaction, categorizeBatch, categorizationStats } from '../src/engine/categorize.js';
import { detectTransfers } from '../src/engine/transfers.js';
import { detectIncomeStreams, markIncome, projectMonthlyIncome } from '../src/engine/income.js';

const state = {
  transactions: [],
  streams: [],
  month: null,
  view: 'dashboard',
  learned: new Map(),
  syncHealth: null,
};

const money = (n) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const moneyExact = (n) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const monthKey = (d) => d.slice(0, 7);
const monthLabel = (key) => {
  const [y, m] = key.split('-');
  return new Date(Date.UTC(+y, +m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
};

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function load() {
  // Demo mode: fixtures only. No network, no credentials.
  const res = await fetch('../fixtures/sample-plaid.json');
  const fixture = await res.json();

  let txns = fixture.transactions.map((t) => normalizePlaidTransaction(t, t.account_id));
  txns = detectTransfers(txns);
  state.streams = detectIncomeStreams(txns);
  txns = markIncome(txns, state.streams);
  state.transactions = categorizeBatch(txns, { learned: state.learned });

  state.accounts = new Map(fixture.accounts.map((a) => [a.account_id, a]));

  const months = [...new Set(state.transactions.map((t) => monthKey(t.posted_date)))].sort();
  state.month = months.at(-1) === '2026-08' ? '2026-07' : months.at(-1);
  state.months = months;
  state.syncHealth = { last_success: new Date().toISOString(), status: 'good', demo: true };
}

// ---------------------------------------------------------------------------
// Derived data. `spending` is defined once, here, so no two views can disagree.
// ---------------------------------------------------------------------------

function spendingIn(month) {
  const parents = new Set(
    state.transactions.map((t) => t.parent_transaction_id).filter(Boolean),
  );
  return state.transactions.filter(
    (t) =>
      monthKey(t.posted_date) === month &&
      !t.is_transfer &&
      !t.is_income &&
      !t.pending &&
      t.amount > 0 &&
      !parents.has(t.plaid_transaction_id),
  );
}

function byCategory(txns) {
  const map = new Map();
  for (const t of txns) {
    const key = t.category || 'Uncategorized';
    map.set(key, (map.get(key) || 0) + t.amount);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Trailing average for a category, over prior months that actually had activity.
 *
 * Two things matter here, and both are ways to show a number that looks precise
 * and is meaningless:
 *
 *   1. Dividing by a fixed 3 when only one prior month has data halves or thirds
 *      the baseline, so an ordinary month reads as a huge overspend. Rent that
 *      was $2,350 both months would show "+100%".
 *   2. A single prior month is not an average. Comparing against it produces
 *      wild percentages from normal variation — one heavier grocery run becomes
 *      "+348%".
 *
 * So: average only over months with activity, and return null (no comparison
 * shown) until there are at least two. Saying nothing beats saying something
 * confidently wrong.
 */
const MIN_MONTHS_FOR_AVERAGE = 2;

function trailingAverage(category, months = 3) {
  const recent = state.months.filter((m) => m < state.month).slice(-months);
  const values = recent
    .map((m) =>
      spendingIn(m)
        .filter((t) => (t.category || 'Uncategorized') === category)
        .reduce((s, t) => s + t.amount, 0),
    )
    .filter((v) => v > 0);

  if (values.length < MIN_MONTHS_FOR_AVERAGE) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function el(html) {
  const div = document.createElement('div');
  div.innerHTML = html.trim();
  return div.firstElementChild;
}

function renderNav() {
  const views = [
    ['dashboard', 'Overview'],
    ['transactions', 'Transactions'],
    ['review', 'Review'],
    ['trends', 'Trends'],
    ['income', 'Income'],
  ];
  const reviewCount = state.transactions.filter((t) => !t.category && !t.is_transfer && !t.is_income).length;

  return `
    <nav class="nav">
      ${views.map(([id, label]) => `
        <button class="nav-btn ${state.view === id ? 'active' : ''}" data-view="${id}">
          ${label}${id === 'review' && reviewCount ? `<span class="badge">${reviewCount}</span>` : ''}
        </button>
      `).join('')}
    </nav>
  `;
}

function renderSyncBanner() {
  const health = state.syncHealth;
  if (!health) return '';

  if (health.demo) {
    return `<div class="banner banner-info">
      Demo mode — synthetic data. No accounts connected, nothing real is being shown.
    </div>`;
  }

  const hours = (Date.now() - new Date(health.last_success).getTime()) / 3600000;
  if (health.status === 'login_required') {
    return `<div class="banner banner-warn">
      <strong>${health.institution_name} needs reconnecting.</strong>
      Your bank ended the connection — this happens a few times a year.
      <button class="link" data-action="reauth">Reconnect</button>
    </div>`;
  }
  // A dashboard rendering stale numbers looks exactly like a working one.
  // Staleness has to be visible or it isn't caught.
  if (hours > 48) {
    return `<div class="banner banner-warn">
      Last synced ${Math.floor(hours / 24)} days ago. These numbers may be out of date.
    </div>`;
  }
  return '';
}

function renderDashboard() {
  const txns = spendingIn(state.month);
  const total = txns.reduce((s, t) => s + t.amount, 0);
  const categories = byCategory(txns);
  const [year, month] = state.month.split('-').map(Number);
  const income = projectMonthlyIncome(state.streams, year, month);
  const net = income.total - total;

  const transfers = state.transactions.filter(
    (t) => monthKey(t.posted_date) === state.month && t.is_transfer && t.amount > 0,
  );
  const transferTotal = transfers.reduce((s, t) => s + t.amount, 0);

  const max = categories.length ? categories[0][1] : 1;

  return `
    <div class="month-picker">
      <button class="chev" data-month-step="-1" ${state.months.indexOf(state.month) <= 0 ? 'disabled' : ''}>‹</button>
      <h2>${monthLabel(state.month)}</h2>
      <button class="chev" data-month-step="1" ${state.months.indexOf(state.month) >= state.months.length - 1 ? 'disabled' : ''}>›</button>
    </div>

    <div class="stat-row">
      <div class="stat">
        <div class="stat-label">Income</div>
        <div class="stat-value income">${money(income.total)}</div>
        <div class="stat-note">${income.detail.map((d) => `${d.paychecks} checks`).join(' + ')}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Spent</div>
        <div class="stat-value">${money(total)}</div>
        <div class="stat-note">${txns.length} transactions</div>
      </div>
      <div class="stat">
        <div class="stat-label">Left over</div>
        <div class="stat-value ${net < 0 ? 'negative' : 'positive'}">${money(net)}</div>
        <div class="stat-note">${net < 0 ? 'overspending' : 'saved'}</div>
      </div>
    </div>

    ${income.detail.some((d) => d.paychecks === 3) ? `
      <div class="banner banner-good">
        <strong>Three-paycheck month.</strong>
        ${income.detail.find((d) => d.paychecks === 3).payee} pays every two weeks, so this
        month has an extra check — about ${money(state.streams.find((s) => s.cadence === 'biweekly')?.typical_amount || 0)}
        more than a normal month. Good month to fund a sinking fund.
      </div>
    ` : ''}

    <h3>Where it went</h3>
    <div class="cat-list">
      ${categories.map(([name, amount]) => {
        const avg = trailingAverage(name);
        const delta = avg ? ((amount - avg) / avg) * 100 : 0;
        const showDelta = avg !== null && Math.abs(delta) > 15;
        return `
          <div class="cat-row" data-category="${name}">
            <div class="cat-head">
              <span class="cat-name">${name}</span>
              <span class="cat-amount">${moneyExact(amount)}</span>
            </div>
            <div class="bar"><div class="bar-fill ${name === 'Uncategorized' ? 'muted' : ''}" style="width:${(amount / max) * 100}%"></div></div>
            ${showDelta ? `
              <div class="cat-note ${delta > 0 ? 'up' : 'down'}">
                ${delta > 0 ? '▲' : '▼'} ${Math.abs(Math.round(delta))}% vs recent average
              </div>` : ''}
          </div>
        `;
      }).join('')}
    </div>

    ${transferTotal > 0 ? `
      <div class="note-box">
        <strong>${moneyExact(transferTotal)} in transfers excluded.</strong>
        Card payments and money moved to savings aren't spending — that spending
        already counted when each purchase was made. Counting it twice would
        overstate this month by ${money(transferTotal)}.
        <details>
          <summary>Show them</summary>
          ${transfers.map((t) => `<div class="mini-row"><span>${t.posted_date}</span><span>${t.payee}</span><span>${moneyExact(t.amount)}</span></div>`).join('')}
        </details>
      </div>
    ` : ''}
  `;
}

function renderTransactions() {
  const txns = state.transactions
    .filter((t) => monthKey(t.posted_date) === state.month && !t.pending)
    .sort((a, b) => b.posted_date.localeCompare(a.posted_date));

  return `
    <h2>${monthLabel(state.month)}</h2>
    <input class="search" id="search" placeholder="Search transactions…" />
    <div class="txn-list" id="txn-list">
      ${txns.map(renderTransactionRow).join('')}
    </div>
  `;
}

function renderTransactionRow(t) {
  const tag = t.is_transfer ? 'transfer' : t.is_income ? 'income' : null;
  return `
    <div class="txn" data-id="${t.plaid_transaction_id}" data-search="${(t.payee + ' ' + (t.category || '')).toLowerCase()}">
      <div class="txn-main">
        <div class="txn-payee">${t.payee}</div>
        <div class="txn-meta">
          ${t.posted_date}
          ${tag ? `<span class="tag tag-${tag}">${tag}</span>` : ''}
          ${t.categorized_by !== 'none' && !tag ? `<span class="tag tag-src" title="Decided by: ${t.categorized_by}">${t.categorized_by}</span>` : ''}
        </div>
      </div>
      <div class="txn-right">
        <div class="txn-amount ${t.amount < 0 ? 'income' : ''}">${moneyExact(Math.abs(t.amount))}</div>
        ${tag ? '' : `<select class="cat-select" data-id="${t.plaid_transaction_id}">
          ${categoryOptions(t.category)}
        </select>`}
      </div>
    </div>
  `;
}

function categoryOptions(selected) {
  const all = [...new Set(state.transactions.map((t) => t.category).filter(Boolean))].sort();
  return [
    `<option value="" ${!selected ? 'selected' : ''}>Uncategorized</option>`,
    ...all.map((c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c}</option>`),
  ].join('');
}

function renderReview() {
  const queue = state.transactions.filter(
    (t) => !t.category && !t.is_transfer && !t.is_income && !t.pending,
  );
  const stats = categorizationStats(state.transactions.filter((t) => !t.is_transfer && !t.is_income));

  if (!queue.length) {
    return `
      <h2>Review</h2>
      <div class="empty">
        <p>Nothing to review.</p>
        <p class="muted">${stats.coverage}% of transactions categorized automatically.</p>
      </div>
    `;
  }

  return `
    <h2>Review</h2>
    <p class="muted">
      ${queue.length} transaction${queue.length > 1 ? 's' : ''} we couldn't categorize confidently.
      Setting one here teaches it permanently — that payee will never need reviewing again.
    </p>
    <div class="txn-list">${queue.map(renderTransactionRow).join('')}</div>
    <div class="note-box">
      <strong>${stats.coverage}% categorized automatically.</strong>
      By layer: ${Object.entries(stats.counts).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}.
      Unknowns are shown rather than guessed at — a wrong category silently
      corrupts your trends, an empty one just asks a question.
    </div>
  `;
}

function renderTrends() {
  const cats = [...new Set(state.months.flatMap((m) => byCategory(spendingIn(m)).map(([c]) => c)))];
  const rows = cats
    .map((cat) => ({
      cat,
      values: state.months.map((m) =>
        spendingIn(m).filter((t) => (t.category || 'Uncategorized') === cat)
          .reduce((s, t) => s + t.amount, 0),
      ),
    }))
    .filter((r) => r.values.some((v) => v > 0))
    .sort((a, b) => b.values.reduce((x, y) => x + y, 0) - a.values.reduce((x, y) => x + y, 0));

  return `
    <h2>Trends</h2>
    <p class="muted">
      What to budget for, from what you actually spent — not from guesses.
    </p>
    <div class="trend-table">
      <div class="trend-head">
        <span>Category</span>
        ${state.months.map((m) => `<span>${monthLabel(m).split(' ')[0].slice(0, 3)}</span>`).join('')}
        <span>Avg</span>
      </div>
      ${rows.map((r) => {
        // Same rule as the dashboard: average only over months with activity,
        // and don't call a single month an average.
        const active = r.values.filter((v) => v > 0);
        const avg = active.length >= MIN_MONTHS_FOR_AVERAGE
          ? active.reduce((a, b) => a + b, 0) / active.length
          : null;
        return `
          <div class="trend-row">
            <span class="trend-cat">${r.cat}</span>
            ${r.values.map((v) => `<span class="${v === 0 ? 'muted' : ''}">${v ? money(v) : '–'}</span>`).join('')}
            <span class="trend-avg ${avg === null ? 'muted' : ''}">${avg === null ? '–' : money(avg)}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderIncome() {
  const [year, month] = state.month.split('-').map(Number);
  const projection = projectMonthlyIncome(state.streams, year, month);

  return `
    <h2>Income</h2>
    <p class="muted">
      Detected from recurring deposits. These are net amounts — what actually lands
      in the account. Gross pay and withholding live on the pay stub, which isn't
      connected.
    </p>

    <div class="stream-list">
      ${state.streams.map((s) => `
        <div class="stream">
          <div class="stream-head">
            <span class="stream-payee">${s.payee}</span>
            <span class="stream-amount">${moneyExact(s.typical_amount)}</span>
          </div>
          <div class="stream-meta">
            ${s.cadence} · next expected ${s.next_expected}
          </div>
        </div>
      `).join('')}
    </div>

    <h3>${monthLabel(state.month)} projection</h3>
    <div class="proj-list">
      ${projection.detail.map((d) => `
        <div class="proj-row ${d.paychecks === 3 ? 'highlight' : ''}">
          <span>${d.payee}</span>
          <span>${d.paychecks} × ${moneyExact(d.amount / d.paychecks)}</span>
          <span>${moneyExact(d.amount)}</span>
        </div>
      `).join('')}
      <div class="proj-row total">
        <span>Total</span><span></span><span>${moneyExact(projection.total)}</span>
      </div>
    </div>

    <div class="note-box">
      <strong>Why the total moves month to month.</strong>
      A biweekly paycheck arrives 26 times a year, so two months out of twelve
      carry a third check. Planning against a flat "monthly income" figure
      under-counts those two months and over-counts the other ten.
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function recategorize(id, category) {
  const txn = state.transactions.find((t) => t.plaid_transaction_id === id);
  if (!txn) return;

  // A human decision. Recorded as a learned rule so this payee is never
  // asked about again — and never overridden by an automated layer.
  txn.category = category || null;
  txn.categorized_by = category ? 'learned' : 'none';
  txn.manually_categorized = Boolean(category);
  if (category) state.learned.set(txn.payee.toLowerCase().replace(/[^a-z0-9]/g, ''), category);

  // Apply to every other transaction from the same payee, which is the whole
  // point of learning it.
  for (const other of state.transactions) {
    if (other !== txn && other.payee === txn.payee && !other.manually_categorized) {
      other.category = category || null;
      other.categorized_by = category ? 'learned' : 'none';
    }
  }
  render();
}

function render() {
  const app = document.getElementById('app');
  const body = {
    dashboard: renderDashboard,
    transactions: renderTransactions,
    review: renderReview,
    trends: renderTrends,
    income: renderIncome,
  }[state.view]();

  app.innerHTML = `
    <header class="header">
      <h1>Family Budget</h1>
    </header>
    ${renderSyncBanner()}
    ${renderNav()}
    <main class="content">${body}</main>
  `;

  app.querySelectorAll('[data-view]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      render();
    }),
  );

  app.querySelectorAll('[data-month-step]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const i = state.months.indexOf(state.month) + Number(btn.dataset.monthStep);
      if (i >= 0 && i < state.months.length) {
        state.month = state.months[i];
        render();
      }
    }),
  );

  app.querySelectorAll('.cat-select').forEach((sel) =>
    sel.addEventListener('change', () => recategorize(sel.dataset.id, sel.value)),
  );

  const search = document.getElementById('search');
  if (search) {
    search.addEventListener('input', () => {
      const q = search.value.toLowerCase();
      document.querySelectorAll('#txn-list .txn').forEach((row) => {
        row.style.display = row.dataset.search.includes(q) ? '' : 'none';
      });
    });
  }
}

load().then(render).catch((e) => {
  document.getElementById('app').innerHTML =
    `<div class="banner banner-warn">Could not load data: ${e.message}</div>`;
});
