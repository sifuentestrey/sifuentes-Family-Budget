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
import { modelIncomeStreams, reliableMonthlyIncome } from '../src/engine/variable-income.js';
import { buildExpensePicture, floorCoverage } from '../src/engine/expenses.js';
import { allocateSeries, findExtraPaycheckMonths } from '../src/engine/allocate.js';
import { buildGuidance, incomeStructureAdvice } from '../src/engine/guidance.js';
import { modelChildTransition } from '../src/engine/child-transition.js';
import { analyzeSubscriptions } from '../src/engine/subscriptions.js';
import { forecastPaycheck, nextPayPeriod } from '../src/payroll/forecast.js';
import { makeTimeEntry, makePayProfile, validatePayProfile } from '../src/domain/payroll.js';
import { daysUntilDue } from '../src/domain/bill.js';

// Loaded lazily, not at the top level: connect.js pulls in the Supabase SDK
// from a CDN, and the rest of this app is explicitly designed to run
// standalone on fixtures with no network at all. A static import would make
// a CDN hiccup break the whole app instead of just the Connect tab.
let connectModule = null;
async function loadConnect() {
  if (!connectModule) {
    connectModule = await import('./connect.js');
    // Re-render on auth changes from elsewhere (another tab signing out, a
    // token refresh) so "Connect" never shows a session that's already gone.
    // Registered once, only after the module has actually loaded.
    connectModule.onAuthChange(() => refreshConnection().then(render));
  }
  return connectModule;
}

// Same reasoning as loadConnect: shifts.js imports the Supabase client, so it
// stays out of the initial module graph.
let shiftsModule = null;
async function loadShifts() {
  if (!shiftsModule) shiftsModule = await import('./shifts.js');
  return shiftsModule;
}

let billsModule = null;
async function loadBills() {
  if (!billsModule) billsModule = await import('./bills.js');
  return billsModule;
}

/** Needs a household, same as shifts — runs once the Connect tab (or a
 * direct visit to Bills after already having a session) has one. */
async function refreshBills() {
  state.billsError = null;
  if (!state.session || !state.householdId) return;

  try {
    const bills = await loadBills();
    [state.bills, state.billsNeedingReview] = await Promise.all([
      bills.listBills(),
      bills.listBillsNeedingReview(),
    ]);
  } catch (e) {
    state.billsError = e.message;
  }
}

/**
 * Load the pay profile and this period's shifts.
 *
 * Needs a household, so it runs only once the Connect tab has established a
 * session. Errors stay on this view for the same reason connection errors stay
 * on Connect — the fixture dashboard must keep working regardless.
 */
async function refreshShifts() {
  state.shiftsError = null;
  if (!state.session || !state.householdId) return;

  let shifts;
  try {
    shifts = await loadShifts();
  } catch {
    state.shiftsError = 'Could not load the shift library. Check your network and reload.';
    return;
  }

  try {
    state.payProfile = await shifts.getPayProfile();
    if (!state.payProfile) {
      state.timeEntries = [];
      return;
    }
    const upcoming = nextPayPeriod(state.payProfile);
    state.payPeriod = upcoming;
    state.timeEntries = upcoming
      ? await shifts.listTimeEntries(upcoming.period.start, upcoming.period.end)
      : [];
  } catch (e) {
    state.shiftsError = e.message;
  }
}

const state = {
  transactions: [],
  streams: [],
  month: null,
  view: 'dashboard',
  learned: new Map(),
  syncHealth: null,
  session: null,
  householdId: null,
  connectedItems: [],
  providerConnections: [],
  members: [],
  invites: [],
  inviteError: null,
  inviteNotice: null,
  inviteBusy: false,
  gmailBusy: false,
  gmailNotice: null,
  gmailError: null,
  payProfile: null,
  payPeriod: null,
  timeEntries: [],
  shiftsError: null,
  shiftsBusy: false,
  shiftsAttempted: false,
  editingProfile: false,
  bills: [],
  billsNeedingReview: [],
  billsError: null,
  billsAttempted: false,
  connectAttempted: false,
  authNotice: null,
  connectBusy: false,
  connectError: null,
  authError: null,
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

  buildPlan();
  // Deliberately not awaited here: the demo dashboard must render immediately
  // on fixtures alone, with zero network dependency, exactly as before. The
  // Connect tab picks up session state the first time it's opened.
}

/**
 * Pick up wherever auth/household/bank-connection state currently stands.
 * Safe to call repeatedly — sign-in, sign-out, and a finished Plaid Link all
 * route through here so the "Connect" view never goes stale.
 *
 * Failure here (most likely: the Supabase SDK's CDN is unreachable) is
 * contained to the Connect tab's own error banner — it must never take down
 * the rest of the app, which needs no network at all.
 */
async function refreshConnection() {
  let connect;
  try {
    connect = await loadConnect();
  } catch {
    state.connectError = 'Could not load the connection library. Check your network and reload.';
    return;
  }

  try {
    state.session = await connect.getSession();
  } catch (e) {
    state.connectError = e.message;
    return;
  }

  if (!state.session) {
    state.householdId = null;
    state.connectedItems = [];
    state.providerConnections = [];
    state.members = [];
    state.invites = [];
    return;
  }
  try {
    state.householdId = await connect.ensureHousehold();
    [state.connectedItems, state.providerConnections, state.members, state.invites] = await Promise.all([
      connect.listConnectedItems(),
      connect.listProviderConnections(),
      connect.listMembers(),
      connect.listInvites(),
    ]);
  } catch (e) {
    state.connectError = e.message;
  }
}

/**
 * Gmail's OAuth redirect lands back on this exact page with `?gmail=...` —
 * read it once on load, translate it into a banner, and strip it from the
 * URL so refreshing the page doesn't replay the same notice.
 */
function consumeGmailOAuthReturn() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('gmail');
  if (!status) return;

  const detail = params.get('gmail_detail');
  if (status === 'connected') {
    state.gmailNotice = 'Gmail connected. The first bill scan runs on the next daily sync.';
  } else if (status === 'denied') {
    state.gmailError = 'Gmail connection cancelled — consent was not granted.';
  } else {
    state.gmailError = `Could not connect Gmail${detail ? `: ${detail}` : ''}.`;
  }

  params.delete('gmail');
  params.delete('gmail_detail');
  const query = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''));
  state.view = 'connect';
}

/**
 * Run the planning engines over the loaded transactions.
 *
 * Recomputed whenever transactions change (a recategorization moves spending
 * between buckets, which moves the baseline, which moves what's safe to save).
 */
function buildPlan() {
  state.streams = modelIncomeStreams(state.streams, state.transactions);
  state.income = reliableMonthlyIncome(state.streams);
  state.picture = buildExpensePicture(state.transactions);
  state.coverage = floorCoverage(state.picture, state.income.reliable);
  state.subs = analyzeSubscriptions(state.transactions);

  const variable = state.streams.find((s) => s.distribution.stability !== 'stable');
  state.variableStream = variable;

  if (variable) {
    const paychecks = state.transactions
      .filter((t) => t.is_income && t.payee === variable.payee)
      .sort((a, b) => a.posted_date.localeCompare(b.posted_date))
      .map((t) => ({ amount: Math.abs(t.amount), date: t.posted_date, cadence: variable.cadence }));

    const commitments = state.picture.categories
      .filter((c) => c.bucket === 'committed')
      .map((c) => ({ category: c.category, amount: c.monthlyAverage, dueDay: 1 }));

    const detail = state.income.detail.find((d) => d.payee === variable.payee);
    const share = state.income.reliable ? detail.monthlyReliable / state.income.reliable : 1;

    state.allocation = allocateSeries(paychecks, {
      commitments,
      irregularAnnualTotal: state.picture.irregularAnnualTotal,
      necessaryMonthly: state.picture.monthly.necessary,
      shareOfHousehold: share,
      openingBuffer: 0,
      nextPayday: variable.next_expected,
    });
    state.extraPaycheckMonths = findExtraPaycheckMonths(paychecks.map((p) => p.date));
  }

  state.structure = incomeStructureAdvice(state.streams, state.picture);
  state.guidance = buildGuidance({
    picture: state.picture,
    coverage: state.coverage,
    monthlySurplus: state.coverage.fullSurplus,
    balances: { buffer: 0, emergency: 0 },
    debts: state.debts ?? [],
    flags: { hasFullEmployerMatch: true, childPlannedWithinYears: 2 },
  });
  state.child = modelChildTransition({
    picture: state.picture,
    reliableMonthlyIncome: state.income.reliable,
    monthlySurplus: state.coverage.fullSurplus,
    leave: {
      weeks: 12, paidWeeks: 6, payReplacementRate: 0.6,
      normalMonthlyIncome: state.streams.find((s) => s.distribution.stability === 'stable')
        ? state.income.detail.find((d) => d.basis === 'median')?.monthlyExpected ?? 0
        : 0,
      isStableEarner: true,
    },
    yearsAway: 2,
  });
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
    ['paycheck', 'Paycheck'],
    ['plan', 'Plan'],
    ['expenses', 'Expenses'],
    ['subscriptions', 'Subs'],
    ['transactions', 'Transactions'],
    ['review', 'Review'],
    ['trends', 'Trends'],
    ['income', 'Income'],
    ['shifts', 'Shifts'],
    ['bills', 'Bills'],
    ['connect', 'Connect'],
  ];
  const reviewCount = state.transactions.filter((t) => !t.category && !t.is_transfer && !t.is_income).length;
  const billsReviewCount = state.billsNeedingReview.length;

  return `
    <nav class="nav">
      ${views.map(([id, label]) => `
        <button class="nav-btn ${state.view === id ? 'active' : ''}" data-view="${id}">
          ${label}${id === 'review' && reviewCount ? `<span class="badge">${reviewCount}</span>` : ''}${id === 'bills' && billsReviewCount ? `<span class="badge">${billsReviewCount}</span>` : ''}
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
// Paycheck — the answer to "how much do I put away from this check?"
// ---------------------------------------------------------------------------

function renderPaycheck() {
  if (!state.allocation) {
    return `<h2>Paycheck</h2><div class="empty">No variable-income stream detected yet.</div>`;
  }

  const latest = state.allocation.allocations.at(-1);
  const isShort = latest.status !== 'surplus';

  return `
    <h2>This paycheck</h2>

    <div class="headline">
      <div class="headline-label">${isShort ? 'Shortfall' : 'Put away'}</div>
      <div class="headline-value ${isShort ? 'bad' : 'good'}">
        ${moneyExact(isShort ? latest.shortfall : latest.surplus)}
      </div>
      <div class="headline-note">${latest.message}</div>
    </div>

    <div class="breakdown">
      <div class="breakdown-row">
        <span class="breakdown-label">Check on ${latest.paycheckDate}</span>
        <span>${moneyExact(latest.paycheckAmount)}</span>
      </div>
      <div class="breakdown-row">
        <span class="breakdown-label">Hold for bills</span><span>−${moneyExact(latest.holdForBills)}</span>
      </div>
      <div class="breakdown-row">
        <span class="breakdown-label">Sinking funds</span><span>−${moneyExact(latest.moveToSinking)}</span>
      </div>
      <div class="breakdown-row">
        <span class="breakdown-label">Groceries &amp; gas (${latest.daysCovered} days)</span>
        <span>−${moneyExact(latest.keepForNecessary)}</span>
      </div>
      <div class="breakdown-row emphasis">
        <span class="breakdown-label">${isShort ? 'Short by' : 'Put away'}</span>
        <span>${moneyExact(isShort ? latest.shortfall : latest.surplus)}</span>
      </div>
    </div>

    ${state.extraPaycheckMonths?.length ? `
      <div class="banner banner-good">
        <strong>Three-paycheck month${state.extraPaycheckMonths.length > 1 ? 's' : ''}:
        ${state.extraPaycheckMonths.map((m) => monthLabel(m.month)).join(', ')}.</strong>
        Monthly bills are covered by the first two checks, so the third is almost
        entirely spare. Worth deciding where it goes before it arrives.
      </div>` : ''}

    <h3>Every check</h3>
    <p class="muted">
      Bill funding is levelled across checks rather than tied to due dates, so what
      you can save tracks how big the check was — not which bills happened to land.
    </p>
    <div class="breakdown">
      ${state.allocation.allocations.map((a) => `
        <div class="breakdown-row ${a.bufferDraw > 0 ? '' : ''}">
          <span class="breakdown-label">${a.paycheckDate} · ${moneyExact(a.paycheckAmount)}</span>
          <span class="${a.status === 'surplus' ? '' : 'negative'}">
            ${a.status === 'surplus' ? moneyExact(a.surplus) : `−${moneyExact(a.shortfall)}`}
          </span>
        </div>`).join('')}
      <div class="breakdown-row emphasis">
        <span class="breakdown-label">Net saved</span>
        <span>${moneyExact(state.allocation.netSaved)}</span>
      </div>
    </div>

    ${state.allocation.checksNeedingBuffer > 0 ? `
      <div class="note-box">
        ${state.allocation.checksNeedingBuffer} of ${state.allocation.allocations.length} checks
        needed the buffer. That is the buffer doing its job — but if it happens often,
        the floor is set too high rather than anything being wrong.
      </div>` : ''}
  `;
}

// ---------------------------------------------------------------------------
// Plan — guidance and the child transition
// ---------------------------------------------------------------------------

function renderPlan() {
  const g = state.guidance;
  const child = state.child;

  return `
    <h2>What to do next</h2>

    ${state.structure ? `
      <div class="note-box">
        <strong>Structure.</strong> ${state.structure.recommendation}
      </div>` : ''}

    ${g.steps.map((step) => `
      <div class="step ${step.status === 'done' ? 'done' : ''}">
        <div class="step-head">
          <span class="step-title">${step.priority}. ${step.title}</span>
          ${step.amount ? `<span class="step-amount">${money(step.amount)}</span>` : ''}
          ${step.status === 'done' ? '<span class="step-amount">✓</span>' : ''}
        </div>
        ${step.monthsToGoal ? `<div class="step-meta">~${step.monthsToGoal} months at current surplus</div>` : ''}
        <div class="step-why">${step.why}</div>
        ${step.comparison ? renderDebtComparison(step.comparison) : ''}
      </div>`).join('')}

    <h3>The child, ~2 years out</h3>
    <div class="split">
      <div class="headline">
        <div class="headline-label">Spare now</div>
        <div class="headline-value good">${money(child.surplus.now)}</div>
        <div class="headline-note">per month</div>
      </div>
      <div class="headline">
        <div class="headline-label">After childcare</div>
        <div class="headline-value ${child.surplus.after < 0 ? 'bad' : ''}">${money(child.surplus.after)}</div>
        <div class="headline-note">${child.surplus.reductionPercent}% absorbed</div>
      </div>
    </div>

    <div class="breakdown">
      <div class="breakdown-row"><span class="breakdown-label">Childcare</span><span>${moneyExact(child.childcare.monthly)}/mo</span></div>
      <div class="breakdown-row"><span class="breakdown-label">Birth (deductible + OOP max)</span><span>${moneyExact(child.birth.cost)}</span></div>
      ${child.leave ? `<div class="breakdown-row"><span class="breakdown-label">Leave income gap</span><span>${moneyExact(child.leave.incomeLost)}</span></div>` : ''}
      <div class="breakdown-row emphasis">
        <span class="breakdown-label">Set aside monthly</span>
        <span>${moneyExact(child.monthlySetAside)}</span>
      </div>
    </div>

    ${child.insights.map((i) => `
      <div class="insight ${i.severity}">
        <div class="insight-title">${i.title}</div>
        <div class="insight-body">${i.detail}</div>
      </div>`).join('')}

    ${child.unknowns.length ? `
      <div class="note-box">
        <strong>Worth finding out — none of this is visible from your transactions:</strong>
        <ul style="margin:8px 0 0; padding-left:18px;">
          ${child.unknowns.map((u) => `<li style="margin-bottom:4px">${u}</li>`).join('')}
        </ul>
      </div>` : ''}

    <div class="disclaimer">${g.disclaimer}</div>
  `;
}

function renderDebtComparison(c) {
  return `
    <div class="breakdown" style="margin-top:10px">
      <div class="breakdown-row">
        <span class="breakdown-label">Avalanche · ${c.avalanche.months} mo</span>
        <span>${moneyExact(c.avalanche.interestPaid)} interest</span>
      </div>
      <div class="breakdown-row">
        <span class="breakdown-label">Snowball · ${c.snowball.months} mo</span>
        <span>${moneyExact(c.snowball.interestPaid)} interest</span>
      </div>
    </div>
    <div class="step-why">${c.note}</div>`;
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

function renderExpenses() {
  const p = state.picture;
  const c = state.coverage;
  const statusClass = c.status === 'covered' ? 'good' : c.status === 'tight' ? '' : 'bad';

  return `
    <h2>Where the money goes</h2>
    <p class="muted">Based on ${p.monthsAnalyzed} complete months.</p>

    <div class="headline">
      <div class="headline-label">Surplus on a slow stretch</div>
      <div class="headline-value ${statusClass}">${money(c.fullSurplus)}</div>
      <div class="headline-note">${c.message}</div>
    </div>

    <div class="breakdown">
      <div class="breakdown-row"><span class="breakdown-label">Committed</span><span>${moneyExact(p.monthly.committed)}</span></div>
      <div class="breakdown-row"><span class="breakdown-label">Necessary</span><span>${moneyExact(p.monthly.necessary)}</span></div>
      <div class="breakdown-row"><span class="breakdown-label">Discretionary</span><span>${moneyExact(p.monthly.discretionary)}</span></div>
      <div class="breakdown-row">
        <span class="breakdown-label">Irregular (spread)</span>
        <span>${moneyExact(p.monthly.irregular)}</span>
      </div>
      <div class="breakdown-row emphasis">
        <span class="breakdown-label">True monthly cost</span><span>${moneyExact(p.trueMonthlyCost)}</span>
      </div>
    </div>

    <div class="note-box">
      <strong>Survival cost is ${moneyExact(p.survivalMonthlyCost)}.</strong>
      That's what an emergency fund should cover — necessities only. Dining out and
      shopping stop in a real emergency, so sizing on total spending inflates the
      target and makes it feel unreachable.
    </div>

    <h3>By category</h3>
    <div class="breakdown">
      ${p.categories.map((c) => `
        <div class="breakdown-row">
          <span class="breakdown-label">
            ${c.category}
            <span class="pill">${c.bucket}</span>
            ${c.reclassified ? '<span class="pill">reclassified</span>' : ''}
          </span>
          <span>${moneyExact(c.monthlyAverage)}</span>
        </div>`).join('')}
    </div>
    <p class="muted" style="margin-top:10px">
      "Reclassified" means the spending pattern overrode the category label — an
      annually-paid premium is spread across the year rather than treated as a
      fixed monthly cost.
    </p>
  `;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

function renderSubscriptions() {
  const s = state.subs;

  return `
    <h2>Subscriptions</h2>

    <div class="headline">
      <div class="headline-label">Annual cost</div>
      <div class="headline-value">${money(s.totalAnnual)}</div>
      <div class="headline-note">
        ${moneyExact(s.totalMonthly)}/mo across ${s.subscriptions.length} services.
        Shown yearly because that's the number that prompts a decision.
      </div>
    </div>

    ${s.priceIncreases.length ? `
      <div class="banner banner-warn">
        <strong>${s.priceIncreases.length} price increase${s.priceIncreases.length > 1 ? 's' : ''}.</strong>
        ${s.priceIncreases.map((p) =>
          `${p.payee} ${moneyExact(p.priceChange.from)} → ${moneyExact(p.priceChange.to)}
           (+${p.priceChange.changePercent}%, ${money(p.annualImpactOfIncrease)}/yr)`).join(' · ')}
      </div>` : ''}

    <div class="breakdown">
      ${s.subscriptions.map((sub) => `
        <div class="breakdown-row">
          <span class="breakdown-label">${sub.payee}
            ${sub.confidence === 'low' ? '<span class="pill">new</span>' : ''}
          </span>
          <span>${moneyExact(sub.last_amount)}/mo · ${money(sub.annualCost)}/yr</span>
        </div>`).join('')}
    </div>

    ${s.duplicates.map((d) => `
      <div class="note-box"><strong>${d.question}</strong>
        ${d.services.map((x) => x.payee).join(', middle')} — ${money(d.combinedAnnual)}/yr combined.
      </div>`).join('')}

    <h3>Recurring bills</h3>
    <p class="muted">Obligations, not subscriptions. Listed so the forecast can use them.</p>
    <div class="breakdown">
      ${s.bills.map((b) => `
        <div class="breakdown-row">
          <span class="breakdown-label">${b.payee}</span>
          <span>${moneyExact(b.last_amount)} ${b.cadence}</span>
        </div>`).join('')}
    </div>

    ${s.frequentMerchants.length ? `
      <p class="muted" style="margin-top:14px">
        ${s.frequentMerchants.map((m) => m.payee).join(', ')} recur too, but they're places
        you shop rather than things you can cancel — kept out of both lists.
      </p>` : ''}
  `;
}

// ---------------------------------------------------------------------------
// Install prompt
// ---------------------------------------------------------------------------

/**
 * iOS has no install event — Apple does not implement beforeinstallprompt, so
 * every iOS install is a manual Add to Home Screen. The only thing we can do is
 * tell people where the button is, and only when they aren't already installed.
 */
function renderConnect() {
  if (!state.session) {
    return `
      <div class="note-box">
        <strong>Sign in to connect a real bank account.</strong>
        Everything else on this page runs on synthetic demo data until you do.
      </div>
      <form id="auth-form" class="step">
        <div class="step-head"><span class="step-title">Sign in or create an account</span></div>
        <p class="step-why">
          <input type="email" name="email" placeholder="Email" required
            style="width:100%;margin-top:8px;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;" />
          <input type="password" name="password" placeholder="Password" minlength="6" required
            style="width:100%;margin-top:8px;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;" />
        </p>
        ${state.authNotice ? `<div class="banner banner-good">${state.authNotice}</div>` : ''}
        ${state.authError ? `<div class="banner banner-warn">${state.authError}</div>` : ''}
        <div class="step-meta" style="display:flex;gap:8px;margin-top:10px;">
          <button type="submit" data-auth="signin" class="link" style="text-decoration:none;padding:9px 14px;border-radius:8px;background:var(--accent-soft);color:var(--accent);font-weight:600;">Sign in</button>
          <button type="submit" data-auth="signup" class="link" style="text-decoration:none;padding:9px 14px;border-radius:8px;border:1px solid var(--border);">Create account</button>
        </div>
      </form>
    `;
  }

  const items = state.connectedItems;
  return `
    <div class="banner banner-good">
      Signed in as ${state.session.user.email}.
      <button class="link" data-action="sign-out">Sign out</button>
    </div>

    ${state.connectError ? `<div class="banner banner-warn">${state.connectError}</div>` : ''}

    <div class="step">
      <div class="step-head">
        <span class="step-title">Bank accounts</span>
        <button data-action="connect-bank" class="link" style="text-decoration:none;padding:9px 14px;border-radius:8px;background:var(--accent-soft);color:var(--accent);font-weight:600;" ${state.connectBusy ? 'disabled' : ''}>
          ${state.connectBusy ? 'Connecting…' : '+ Connect a bank'}
        </button>
      </div>
      ${items.length === 0 ? `<p class="step-why">No accounts connected yet. Plaid Link opens in its own secure window — your bank credentials never touch this app.</p>` : `
        <div class="stream-list" style="margin-top:10px;">
          ${items.map((item) => `
            <div class="stream">
              <div class="stream-head">
                <span class="stream-payee">${item.institution_name}</span>
                <span class="pill ${item.status === 'good' ? 'stable' : 'variable'}">${item.status}</span>
              </div>
              <div class="stream-meta">
                ${(item.accounts ?? []).map((a) => `${a.nickname} ····${a.mask ?? ''}`).join(' · ') || 'No accounts yet'}
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>

    <div class="step">
      <div class="step-head">
        <span class="step-title">Email (bills)</span>
      </div>
      ${state.gmailNotice ? `<div class="banner banner-good">${state.gmailNotice}</div>` : ''}
      ${state.gmailError ? `<div class="banner banner-warn">${state.gmailError}</div>` : ''}
      ${(() => {
        const gmail = state.providerConnections.find((c) => c.provider_key === 'gmail');
        if (!gmail || gmail.status === 'disconnected') {
          return `
            <p class="step-why">
              Scans for bill-looking mail (statements, "amount due", "payment due") and nothing
              else — read-only access, no email is ever sent or modified. Google's own consent
              screen is where you approve this, not this app.
            </p>
            <button data-action="connect-gmail" class="link" style="text-decoration:none;padding:9px 14px;border-radius:8px;background:var(--accent-soft);color:var(--accent);font-weight:600;" ${state.gmailBusy ? 'disabled' : ''}>
              ${state.gmailBusy ? 'Connecting…' : '+ Connect Gmail'}
            </button>`;
        }
        const statusLabel = {
          connected: 'connected', needs_reauth: 'needs reconnect', error: 'error',
        }[gmail.status] ?? gmail.status;
        return `
          <div class="stream">
            <div class="stream-head">
              <span class="stream-payee">Gmail</span>
              <span class="pill ${gmail.status === 'connected' ? 'stable' : 'variable'}">${statusLabel}</span>
            </div>
            <div class="stream-meta">
              ${gmail.last_synced_at ? `Last scanned ${new Date(gmail.last_synced_at).toLocaleString()}` : 'Not scanned yet — runs on the next daily sync'}
              ${gmail.status_detail ? ` · ${gmail.status_detail}` : ''}
            </div>
          </div>
          <button data-action="disconnect-gmail" class="link" style="margin-top:10px;" ${state.gmailBusy ? 'disabled' : ''}>
            ${state.gmailBusy ? 'Disconnecting…' : 'Disconnect'}
          </button>
          ${gmail.status === 'needs_reauth' ? `
            <button data-action="connect-gmail" class="link" style="margin-top:10px;margin-left:8px;" ${state.gmailBusy ? 'disabled' : ''}>
              Reconnect
            </button>` : ''}
        `;
      })()}
    </div>

    <div class="step">
      <div class="step-head"><span class="step-title">Who's in this household</span></div>
      <div class="stream-list" style="margin-top:10px;">
        ${state.members.map((m) => `
          <div class="stream">
            <div class="stream-head">
              <span class="stream-payee">${m.display_name}</span>
              ${m.user_id === state.session.user.id ? '<span class="pill stable">you</span>' : ''}
            </div>
          </div>
        `).join('')}
      </div>

      <p class="step-why" style="margin-top:14px;">
        Signup is invite-only. Anyone who finds this page can open it, but they cannot
        create an account unless someone here invites their email address first.
      </p>

      <form id="invite-form">
        <input type="email" name="email" placeholder="Their email address" required
          style="width:100%;margin-top:8px;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;" />
        ${state.inviteNotice ? `<div class="banner banner-good" style="margin-top:8px;">${state.inviteNotice}</div>` : ''}
        ${state.inviteError ? `<div class="banner banner-warn" style="margin-top:8px;">${state.inviteError}</div>` : ''}
        <button type="submit" class="link" ${state.inviteBusy ? 'disabled' : ''}
          style="text-decoration:none;padding:9px 14px;border-radius:8px;background:var(--accent-soft);color:var(--accent);font-weight:600;margin-top:10px;display:inline-block;">
          ${state.inviteBusy ? 'Inviting…' : 'Send invite'}
        </button>
      </form>

      ${state.invites.length === 0 ? '' : `
        <div class="stream-list" style="margin-top:14px;">
          ${state.invites.map((inv) => `
            <div class="stream">
              <div class="stream-head">
                <span class="stream-payee">${inv.email}</span>
                <button class="link" data-action="revoke-invite" data-id="${inv.id}">Revoke</button>
              </div>
              <div class="stream-meta">
                Invited — can create an account until ${new Date(inv.expires_at).toLocaleDateString()}
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>

    <div class="disclaimer">
      Connecting a bank replaces nothing shown elsewhere in this app yet — the rest of the
      dashboard still runs on demo data until live sync is wired into the other views.
    </div>
  `;
}

const FIELD_STYLE =
  'width:100%;margin-top:6px;padding:10px;border-radius:8px;border:1px solid var(--border);' +
  'background:var(--bg);color:var(--text);font:inherit;';
const BUTTON_STYLE =
  'text-decoration:none;padding:9px 14px;border-radius:8px;background:var(--accent-soft);' +
  'color:var(--accent);font-weight:600;margin-top:10px;display:inline-block;';

function field(label, name, type, value, extra = '') {
  return `
    <label style="display:block;margin-top:10px;font-size:13px;color:var(--muted);">
      ${label}
      <input type="${type}" name="${name}" value="${value ?? ''}" style="${FIELD_STYLE}" ${extra} />
    </label>`;
}

/**
 * Shift logging and the forecast it feeds.
 *
 * This is the one number Plaid cannot produce. A bank feed shows the deposit
 * after it has landed; for income that swings with how many shifts were worked,
 * knowing the check in advance is the whole point.
 */
function renderShifts() {
  if (!state.session) {
    return `
      <div class="note-box">
        <strong>Sign in to log shifts.</strong>
        Shifts are shared across the household, so they live in the database
        rather than on one phone — open the Connect tab to sign in.
      </div>`;
  }

  if (state.shiftsError) {
    return `<div class="banner banner-warn">${state.shiftsError}</div>`;
  }

  const p = state.payProfile;

  if (!p || state.editingProfile) {
    return `
      <div class="note-box">
        <strong>How you get paid.</strong>
        Two defaults here are deliberately not the usual ones, because the usual
        ones are wrong for call work — see the notes under each.
      </div>
      <form id="pay-profile-form" class="step">
        <div class="step-head"><span class="step-title">${p ? 'Edit pay setup' : 'Set up your pay'}</span></div>
        ${field('Label', 'label', 'text', p?.label ?? 'Primary', 'required')}
        ${field('Employer (optional)', 'employerName', 'text', p?.employerName ?? '')}
        ${field('Base hourly rate', 'baseHourlyRate', 'number', p?.baseHourlyRate ?? '', 'step="0.01" min="0.01" required')}
        ${field('Overtime multiplier', 'overtimeMultiplier', 'number', p?.overtimeMultiplier ?? 1.5, 'step="0.1" min="1" required')}

        ${field('Daily overtime threshold (hours)', 'dailyOvertimeThreshold', 'number', p?.dailyOvertimeThreshold ?? 0, 'step="0.5" min="0" required')}
        <p class="step-why">
          <strong>0 disables it</strong>, which is the right default for a compressed
          schedule. An 8-hour threshold turns every 10-hour shift into 2 hours of
          overtime that you were never paid — roughly 8 phantom hours a week.
        </p>

        ${field('Weekly overtime threshold (hours)', 'weeklyOvertimeThreshold', 'number', p?.weeklyOvertimeThreshold ?? 40, 'step="0.5" min="0" required')}

        ${field('Callback minimum (hours paid per callout)', 'callbackMinimumHours', 'number', p?.callbackMinimumHours ?? 0, 'step="0.5" min="0" required')}
        <p class="step-why">
          Paid <em>per event</em>, not per hour worked. Two 30-minute callouts on a
          2-hour minimum pay 4 hours, not 1.
        </p>

        ${field('Callback multiplier', 'callbackMultiplier', 'number', p?.callbackMultiplier ?? 1.5, 'step="0.1" min="1" required')}
        ${field('Standby rate', 'standbyRate', 'number', p?.standbyRate ?? 0, 'step="0.01" min="0" required')}
        <p class="step-why">
          Standby is time on call. It pays its own rate and never counts toward an
          overtime threshold.
        </p>

        <label style="display:block;margin-top:10px;font-size:13px;color:var(--muted);">
          Pay frequency
          <select name="payFrequency" style="${FIELD_STYLE}">
            ${['weekly', 'biweekly', 'semimonthly', 'monthly'].map((f) => `
              <option value="${f}" ${(p?.payFrequency ?? 'biweekly') === f ? 'selected' : ''}>${f}</option>
            `).join('')}
          </select>
        </label>

        ${field('A pay period you know: start', 'payPeriodStart', 'date', p?.payPeriodStart ?? '', 'required')}
        ${field('…and its end', 'payPeriodEnd', 'date', p?.payPeriodEnd ?? '', 'required')}
        ${field('…and the payday for it', 'payday', 'date', p?.payday ?? '', 'required')}
        <p class="step-why">
          Periods are walked forward from this anchor rather than computed from
          today, so they stay aligned to your employer's actual calendar.
        </p>

        ${field('Estimated tax + deduction rate (%)', 'taxRate', 'number',
          p?.taxAssumptions?.federalRate != null
            ? Math.round((p.taxAssumptions.federalRate + (p.taxAssumptions.stateRate ?? 0)) * 100)
            : 18, 'step="1" min="0" max="60" required')}
        <p class="step-why">
          A starting guess for federal + state. Social Security and Medicare are
          added automatically. Once you enter a real paystub the app learns your
          actual effective rate — that is usually the biggest source of error in a
          take-home estimate.
        </p>

        <button type="submit" class="link" style="${BUTTON_STYLE}" ${state.shiftsBusy ? 'disabled' : ''}>
          ${state.shiftsBusy ? 'Saving…' : 'Save pay setup'}
        </button>
        ${p ? `<button type="button" data-action="cancel-profile" class="link" style="margin-left:10px;">Cancel</button>` : ''}
      </form>`;
  }

  const period = state.payPeriod;
  const forecast = period
    ? forecastPaycheck({
      profile: p,
      entries: state.timeEntries,
      period: period.period,
      payDate: period.payDate,
    })
    : null;

  return `
    ${forecast ? `
      <div class="step">
        <div class="step-head">
          <span class="step-title">Next check — ${new Date(`${forecast.payDate}T00:00:00`).toLocaleDateString()}</span>
          <span class="pill ${forecast.confidence === 'high' ? 'stable' : 'variable'}">${forecast.confidence} confidence</span>
        </div>
        <div class="big-number">${moneyExact(forecast.estimatedNet)}</div>
        <div class="stream-meta">
          Estimated take-home for ${forecast.period.start} → ${forecast.period.end}.
          ${forecast.daysCovered} of ${forecast.daysInPeriod} days logged.
        </div>
        <div class="stream-list" style="margin-top:12px;">
          <div class="stream"><div class="stream-head">
            <span class="stream-payee">Gross</span><span>${moneyExact(forecast.breakdown.totalGross)}</span></div></div>
          <div class="stream"><div class="stream-head">
            <span class="stream-payee">Taxes</span><span>−${moneyExact(forecast.breakdown.totalTaxes)}</span></div></div>
          <div class="stream"><div class="stream-head">
            <span class="stream-payee">Deductions</span><span>−${moneyExact(forecast.breakdown.totalDeductions)}</span></div></div>
        </div>
        ${forecast.confidenceReasons.length ? `
          <p class="step-why" style="margin-top:10px;">
            ${forecast.confidenceReasons.join(' · ')}
          </p>` : ''}
      </div>` : `
      <div class="banner banner-warn">
        No upcoming pay period — check the anchor dates in your pay setup.
      </div>`}

    <div class="step">
      <div class="step-head">
        <span class="step-title">Log a shift</span>
        <button data-action="edit-profile" class="link">Pay setup</button>
      </div>
      <form id="shift-form">
        ${field('Date', 'date', 'date', new Date().toISOString().slice(0, 10), 'required')}
        ${field('Hours worked', 'regularHours', 'number', '', 'step="0.25" min="0" required')}
        ${field('Callback hours', 'callbackHours', 'number', '', 'step="0.25" min="0"')}
        ${field('Number of callouts', 'callbackEvents', 'number', '', 'step="1" min="0"')}
        ${field('Standby hours (on call)', 'standbyHours', 'number', '', 'step="0.25" min="0"')}
        ${field('Holiday hours', 'holidayHours', 'number', '', 'step="0.25" min="0"')}
        ${field('PTO hours', 'ptoHours', 'number', '', 'step="0.25" min="0"')}
        <button type="submit" class="link" style="${BUTTON_STYLE}" ${state.shiftsBusy ? 'disabled' : ''}>
          ${state.shiftsBusy ? 'Saving…' : 'Add shift'}
        </button>
      </form>
    </div>

    <div class="step">
      <div class="step-head"><span class="step-title">This period</span></div>
      ${state.timeEntries.length === 0 ? `
        <p class="step-why">No shifts logged for this period yet.</p>` : `
        <div class="stream-list" style="margin-top:10px;">
          ${state.timeEntries.map((e) => `
            <div class="stream">
              <div class="stream-head">
                <span class="stream-payee">${new Date(`${e.date}T00:00:00`).toLocaleDateString()}</span>
                <button class="link" data-action="delete-shift" data-id="${e.id}">Remove</button>
              </div>
              <div class="stream-meta">
                ${[
                  e.regularHours ? `${e.regularHours}h worked` : '',
                  e.callbackEvents ? `${e.callbackEvents} callout${e.callbackEvents > 1 ? 's' : ''} (${e.callbackHours}h)` : '',
                  e.standbyHours ? `${e.standbyHours}h standby` : '',
                  e.holidayHours ? `${e.holidayHours}h holiday` : '',
                  e.ptoHours ? `${e.ptoHours}h PTO` : '',
                ].filter(Boolean).join(' · ')}
              </div>
            </div>`).join('')}
        </div>`}
    </div>

    <div class="disclaimer">
      An estimate from the hours logged here, not a promise from your employer.
      Enter a real paystub once one arrives and the app corrects its own tax
      assumptions against it.
    </div>`;
}

/**
 * Bills detected from Gmail. Plaid shows a payment after it lands; a bill is
 * the one piece of information the household needs *before* that, which is
 * the entire reason this exists rather than waiting for the bank feed.
 */
function renderBills() {
  if (!state.session) {
    return `
      <div class="note-box">
        <strong>Sign in to see bills.</strong>
        Bills are shared across the household, so they live in the database —
        open the Connect tab to sign in.
      </div>`;
  }

  if (state.billsError) {
    return `<div class="banner banner-warn">${state.billsError}</div>`;
  }

  const gmail = state.providerConnections.find((c) => c.provider_key === 'gmail');
  if (!gmail || gmail.status === 'disconnected') {
    return `
      <div class="note-box">
        <strong>No email connected yet.</strong>
        Connect Gmail from the Connect tab to start finding bills automatically —
        nothing here populates on its own before that.
      </div>`;
  }

  const review = state.billsNeedingReview;
  const bills = state.bills;
  const urgency = (dueDate) => (daysUntilDue({ dueDate }) <= 7 ? 'variable' : 'stable');

  return `
    ${review.length ? `
      <div class="step">
        <div class="step-head"><span class="step-title">Needs review (${review.length})</span></div>
        <p class="step-why">
          Parsed with low confidence — confirm before it counts toward what's due, or
          dismiss if this isn't actually a bill (a payment receipt, a promo email that
          used billing language).
        </p>
        <div class="stream-list" style="margin-top:10px;">
          ${review.map((b) => `
            <div class="stream">
              <div class="stream-head">
                <span class="stream-payee">${b.providerName}</span>
                <span class="pill variable">${moneyExact(b.amountDue)}</span>
              </div>
              <div class="stream-meta">Due ${b.dueDate} · confidence ${Math.round(b.confidence * 100)}%</div>
              <div style="margin-top:8px;display:flex;gap:8px;">
                <button class="link" data-action="confirm-bill" data-id="${b.id}">Confirm</button>
                <button class="link" data-action="dismiss-bill" data-id="${b.id}">Dismiss</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}

    <div class="step">
      <div class="step-head"><span class="step-title">Upcoming bills</span></div>
      ${bills.length === 0 ? `
        <p class="step-why">
          No bills detected yet. ${gmail.last_synced_at ? 'The last scan found nothing due — check back after the next daily sync.' : 'The first scan runs on the next daily sync.'}
        </p>` : `
        <div class="stream-list" style="margin-top:10px;">
          ${bills.map((b) => `
            <div class="stream">
              <div class="stream-head">
                <span class="stream-payee">${b.providerName}</span>
                <span class="pill ${urgency(b.dueDate)}">${moneyExact(b.amountDue)}</span>
              </div>
              <div class="stream-meta">Due ${b.dueDate} · ${b.category} · ${b.status}</div>
            </div>
          `).join('')}
        </div>
      `}
    </div>
  `;
}

function renderInstallHint() {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (standalone || localStorage.getItem('installHintDismissed')) return '';

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!isIOS) return '';

  return `
    <div class="install-hint" id="install-hint">
      <strong>Add to your home screen.</strong>
      Tap the Share button in Safari, then “Add to Home Screen”. It opens like an app
      and works without a signal.
      <br /><button data-action="dismiss-install">Dismiss</button>
    </div>`;
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

  // Recategorizing moves spending between buckets, which moves the baseline,
  // which moves what a paycheck can spare. Everything downstream is stale until
  // this runs.
  buildPlan();
  render();
}

function render() {
  const app = document.getElementById('app');
  const body = {
    dashboard: renderDashboard,
    paycheck: renderPaycheck,
    plan: renderPlan,
    expenses: renderExpenses,
    subscriptions: renderSubscriptions,
    transactions: renderTransactions,
    review: renderReview,
    trends: renderTrends,
    income: renderIncome,
    shifts: renderShifts,
    bills: renderBills,
    connect: renderConnect,
  }[state.view]();

  app.innerHTML = `
    <header class="header">
      <h1>Family Budget</h1>
    </header>
    ${renderSyncBanner()}
    ${renderNav()}
    <main class="content">${body}</main>
    ${renderInstallHint()}
  `;

  const dismiss = app.querySelector('[data-action="dismiss-install"]');
  if (dismiss) {
    dismiss.addEventListener('click', () => {
      localStorage.setItem('installHintDismissed', '1');
      document.getElementById('install-hint')?.remove();
    });
  }

  app.querySelectorAll('[data-view]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      // First visit to Connect is what triggers loading the Supabase SDK —
      // every other view stays entirely offline-capable.
      if (state.view === 'connect' && !state.connectAttempted) {
        state.connectAttempted = true;
        // A full re-render replaces the whole #app subtree, which would wipe
        // out anything the user already typed into the auth form if they're
        // faster than this resolves. Skip the re-render in that case — the
        // fetched session/household state is still applied either way.
        refreshConnection().then(() => {
          const form = document.getElementById('auth-form');
          if (!form || (!form.email.value && !form.password.value)) render();
        });
      }
      // Shifts needs the same session, and reaching it without passing through
      // Connect is normal once signed in — so it establishes the session too
      // rather than showing an empty state that a reload would fix.
      if (state.view === 'shifts' && !state.shiftsAttempted) {
        state.shiftsAttempted = true;
        const haveSession = state.connectAttempted;
        state.connectAttempted = true; // don't make Connect redo this
        (haveSession ? Promise.resolve() : refreshConnection())
          .then(refreshShifts)
          .then(render);
      }
      // Same reasoning as Shifts: Bills needs a session and a household, and
      // reaching it directly (already signed in, or a second visit) is normal.
      if (state.view === 'bills' && !state.billsAttempted) {
        state.billsAttempted = true;
        const haveSession = state.connectAttempted;
        state.connectAttempted = true;
        (haveSession ? Promise.resolve() : refreshConnection())
          .then(refreshBills)
          .then(render);
      }
      render(); // shows the view immediately either way
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

  const authForm = document.getElementById('auth-form');
  if (authForm) {
    authForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const mode = ev.submitter?.dataset.auth ?? 'signin';
      const email = authForm.email.value.trim();
      const password = authForm.password.value;
      state.authError = null;
      state.authNotice = null;
      try {
        const connect = await loadConnect();
        if (mode === 'signup') {
          const { needsConfirmation } = await connect.signUp(email, password);
          if (needsConfirmation) {
            state.authNotice = `Check ${email} for a confirmation link, then sign in.`;
          }
        } else {
          await connect.signIn(email, password);
        }
        await refreshConnection();
        await refreshShifts();
      } catch (e) {
        state.authError = e.message;
      }
      render();
    });
  }

  const signOutBtn = app.querySelector('[data-action="sign-out"]');
  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      const connect = await loadConnect();
      await connect.signOut();
      state.payProfile = null;
      state.timeEntries = [];
      state.payPeriod = null;
      await refreshConnection();
      render();
    });
  }

  const connectBtn = app.querySelector('[data-action="connect-bank"]');
  if (connectBtn) {
    connectBtn.addEventListener('click', async () => {
      state.connectBusy = true;
      state.connectError = null;
      render();
      try {
        const connect = await loadConnect();
        await connect.connectBank();
        await refreshConnection();
      } catch (e) {
        state.connectError = e.message;
      }
      state.connectBusy = false;
      render();
    });
  }

  app.querySelectorAll('[data-action="connect-gmail"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.gmailBusy = true;
      state.gmailError = null;
      state.gmailNotice = null;
      render();
      try {
        const connect = await loadConnect();
        // Full-page redirect to Google — this call does not return; the next
        // render happens on the page Google sends the browser back to.
        await connect.connectGmail();
      } catch (e) {
        state.gmailError = e.message;
        state.gmailBusy = false;
        render();
      }
    });
  });

  const disconnectGmailBtn = app.querySelector('[data-action="disconnect-gmail"]');
  if (disconnectGmailBtn) {
    disconnectGmailBtn.addEventListener('click', async () => {
      state.gmailBusy = true;
      render();
      try {
        const connect = await loadConnect();
        await connect.disconnectGmail();
        await refreshConnection();
        state.gmailNotice = 'Gmail disconnected.';
      } catch (e) {
        state.gmailError = e.message;
      }
      state.gmailBusy = false;
      render();
    });
  }

  const inviteForm = document.getElementById('invite-form');
  if (inviteForm) {
    inviteForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const email = inviteForm.email.value.trim();
      state.inviteBusy = true;
      state.inviteError = null;
      state.inviteNotice = null;
      render();
      try {
        const connect = await loadConnect();
        await connect.createInvite(email);
        // Deliberately not an email — no mail provider is configured, and
        // inventing one would mean an invite that silently never arrives.
        // Telling them to pass the link along is honest and works today.
        state.inviteNotice =
          `${email} can now create an account. Send them this page's link — ` +
          `they sign up with that address and land straight in this household.`;
        await refreshConnection();
      } catch (e) {
        state.inviteError = e.message;
      }
      state.inviteBusy = false;
      render();
    });
  }

  const profileForm = document.getElementById('pay-profile-form');
  if (profileForm) {
    profileForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = profileForm;
      const num = (name) => Number(f[name].value);

      // Social Security and Medicare are statutory and not the user's to guess,
      // so only the income-tax portion comes from the form.
      const incomeTaxRate = num('taxRate') / 100;
      const profile = makePayProfile({
        label: f.label.value.trim(),
        employerName: f.employerName.value.trim(),
        baseHourlyRate: num('baseHourlyRate'),
        overtimeMultiplier: num('overtimeMultiplier'),
        dailyOvertimeThreshold: num('dailyOvertimeThreshold'),
        weeklyOvertimeThreshold: num('weeklyOvertimeThreshold'),
        callbackMinimumHours: num('callbackMinimumHours'),
        callbackMultiplier: num('callbackMultiplier'),
        standbyRate: num('standbyRate'),
        payFrequency: f.payFrequency.value,
        payPeriodStart: f.payPeriodStart.value,
        payPeriodEnd: f.payPeriodEnd.value,
        payday: f.payday.value,
        taxAssumptions: {
          federalRate: incomeTaxRate,
          stateRate: 0,
          socialSecurityRate: 0.062,
          medicareRate: 0.0145,
        },
      });

      const problems = validatePayProfile(profile);
      if (problems.length) {
        state.shiftsError = problems.join('. ');
        render();
        return;
      }

      state.shiftsBusy = true;
      state.shiftsError = null;
      render();
      try {
        const shifts = await loadShifts();
        await shifts.savePayProfile(profile, state.householdId, state.payProfile?.id);
        state.editingProfile = false;
        await refreshShifts();
      } catch (e) {
        state.shiftsError = e.message;
      }
      state.shiftsBusy = false;
      render();
    });
  }

  const shiftForm = document.getElementById('shift-form');
  if (shiftForm) {
    shiftForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = shiftForm;
      const num = (name) => Number(f[name].value || 0);

      const entry = makeTimeEntry({
        date: f.date.value,
        regularHours: num('regularHours'),
        callbackHours: num('callbackHours'),
        callbackEvents: f.callbackEvents.value ? num('callbackEvents') : undefined,
        standbyHours: num('standbyHours'),
        holidayHours: num('holidayHours'),
        ptoHours: num('ptoHours'),
      });

      state.shiftsBusy = true;
      state.shiftsError = null;
      render();
      try {
        const shifts = await loadShifts();
        await shifts.saveTimeEntry(entry, state.householdId, state.payProfile.id);
        await refreshShifts();
      } catch (e) {
        state.shiftsError = e.message;
      }
      state.shiftsBusy = false;
      render();
    });
  }

  const editProfileBtn = app.querySelector('[data-action="edit-profile"]');
  if (editProfileBtn) {
    editProfileBtn.addEventListener('click', () => {
      state.editingProfile = true;
      render();
    });
  }

  const cancelProfileBtn = app.querySelector('[data-action="cancel-profile"]');
  if (cancelProfileBtn) {
    cancelProfileBtn.addEventListener('click', () => {
      state.editingProfile = false;
      state.shiftsError = null;
      render();
    });
  }

  app.querySelectorAll('[data-action="delete-shift"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.shiftsError = null;
      try {
        const shifts = await loadShifts();
        await shifts.deleteTimeEntry(btn.dataset.id);
        await refreshShifts();
      } catch (e) {
        state.shiftsError = e.message;
      }
      render();
    });
  });

  app.querySelectorAll('[data-action="confirm-bill"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const bills = await loadBills();
        await bills.confirmBill(btn.dataset.id);
        await refreshBills();
      } catch (e) {
        state.billsError = e.message;
      }
      render();
    });
  });

  app.querySelectorAll('[data-action="dismiss-bill"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const bills = await loadBills();
        await bills.dismissBill(btn.dataset.id);
        await refreshBills();
      } catch (e) {
        state.billsError = e.message;
      }
      render();
    });
  });

  app.querySelectorAll('[data-action="revoke-invite"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.inviteError = null;
      state.inviteNotice = null;
      try {
        const connect = await loadConnect();
        await connect.revokeInvite(btn.dataset.id);
        await refreshConnection();
      } catch (e) {
        state.inviteError = e.message;
      }
      render();
    });
  });
}

consumeGmailOAuthReturn();

load().then(async () => {
  // Returning from Gmail's consent screen always means a session already
  // exists — load it now rather than waiting for a click on the Connect tab,
  // so the notice above appears next to state that's actually current.
  if (state.gmailNotice || state.gmailError) {
    state.connectAttempted = true;
    await refreshConnection();
  }
  render();
}).catch((e) => {
  document.getElementById('app').innerHTML =
    `<div class="banner banner-warn">Could not load data: ${e.message}</div>`;
});
