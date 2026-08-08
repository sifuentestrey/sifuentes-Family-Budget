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

  buildPlan();
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
