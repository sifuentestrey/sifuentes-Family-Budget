Warning: truncated output (original token count: 46768)
Total output lines: 4661

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
import { buildAlerts } from '../src/engine/alerts.js';
import { calculateSafeToSpend } from '../src/engine/budget/safe-to-spend.js';
import { buildMonthlyBudget } from '../src/engine/budget/monthly-budget.js';
import { buildMonthInFull } from '../src/engine/month-in-full.js';
import { isSplitParent, planSplit } from '../src/engine/split.js';
import { buildYearInReview } from '../src/engine/year-in-review.js';
import { forecastPaycheck, nextPayPeriod } from '../src/payroll/forecast.js';
import { reconcilePaycheck, learnFromHistory, applyLearnedAdjustments } from '../src/payroll/reconcile.js';
import { makeTimeEntry, makePayProfile, validatePayProfile, makePaystub, validatePaystub } from '../src/domain/payroll.js';
import { daysUntilDue } from '../src/domain/bill.js';
import { planPaycheckCoverage } from '../src/engine/bill-paycheck-plan.js';
import { suggestBillsFromTransactions } from '../src/engine/bill-suggestions.js';
import { payeeStem } from '../src/engine/similar-payee.js';
import { domainForPayee, logoSources } from '../src/engine/merchant-domain.js';
import { SEED_CATEGORIES } from '../src/engine/seed-rules.js';

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
  // Both halves of the Budget tab, fetched together: a screen that had bills
  // but not the household's targets would quietly fall back to averages and
  // show numbers neither person set.
  await refreshBudgetTargets();
  refreshAlerts();
}

/**
 * Name whatever the deterministic layers couldn't, without being asked.
 *
 * The household's position was simply "I don't want to review a hundred
 * things", and a button that has to be found and pressed is still a review
 * queue with extra steps. So this runs on load, once per session, quietly:
 * no spinner over the dashboard, no banner if it found nothing, a re-render
 * only if it actually changed something.
 *
 * The safety properties are the same ones the nightly sweep relies on and
 * they live server-side, not here: only rows still uncategorized are touched,
 * a human's decision is never overwritten, and anything the model isn't
 * confident about is left alone rather than force-fitted to a guess.
 *
 * Failure is deliberately silent. This is a background improvement to a
 * screen that already works — an error toast for something nobody asked for
 * is noise, and the manual button on the review screen reports properly for
 * anyone who does ask.
 */
let autoCategorizeAttempted = false;
async function autoCategorizeUnknowns() {
  if (autoCategorizeAttempted) return;
  if (!state.session || !state.householdId) return;
  if (!uncategorizedCount()) return;
  autoCategorizeAttempted = true;

  try {
    const connect = await loadConnect();
    const { categorized } = await connect.categorizeUnknowns();
    if (!categorized) return;

    state.transactions = await connect.listTransactions();
    buildPlan();
    state.autoCategorizeResult = `${categorized} categorized automatically.`;
    render();
  } catch {
    /* Silent on purpose — see above. */
  }
}

let budgetTargetsModule = null;
async function loadBudgetTargetsModule() {
  if (!budgetTargetsModule) budgetTargetsModule = await import('./budget-targets.js');
  return budgetTargetsModule;
}

/**
 * Budget targets live in the database because a budget is an agreement
 * between the two people in the household — a number only one phone can see
 * is not an agreement. Fetched with bills, since both feed the Budget tab.
 */
async function refreshBudgetTargets() {
  state.budgetTargetsError = null;
  if (!state.session || !state.householdId) return;

  try {
    const mod = await loadBudgetTargetsModule();
    await migrateLocalBudgetTargets(mod);
    state.budgetTargets = await mod.listBudgetTargets();
  } catch (e) {
    state.budgetTargetsError = e.message;
  }
}

/**
 * Targets set before they were shared were kept in localStorage. Push them
 * up once on the first signed-in load and drop the local copy, so nobody
 * loses the numbers they already entered and the two sources can't drift.
 * Existing household targets win — the shared value is the agreed one.
 */
async function migrateLocalBudgetTargets(mod) {
  let local;
  try {
    local = JSON.parse(localStorage.getItem('budgetTargets') ?? 'null');
  } catch {
    local = null;
  }
  if (!local || !Object.keys(local).length) return;

  const existing = await mod.listBudgetTargets();
  for (const [category, amount] of Object.entries(local)) {
    if (existing[category] !== undefined) continue;
    if (!Number.isFinite(Number(amount))) continue;
    await mod.saveBudgetTarget(state.householdId, category, Number(amount));
  }
  try {
    localStorage.removeItem('budgetTargets');
  } catch {
    /* Nothing to do — the rows are saved either way. */
  }
}

/** Loads only the note history — generating a new one is a deliberate,
 * user-triggered action (see the "Get check-in" button), not something
 * that happens automatically on every visit to the tab. */
async function refreshAdvisorNotes() {
  state.advisorError = null;
  if (!state.session || !state.householdId) return;

  try {
    const connect = await loadConnect();
    state.advisorNotes = await connect.listAdvisorNotes();
  } catch (e) {
    state.advisorError = e.message;
  }
}

/**
 * Aggregate-only snapshot of the household's current numbers, built from the
 * same engine output every other view already renders from. Sent to the
 * advisor edge function instead of raw transactions — a narrative note has
 * no use for individual purchases, only the shape of the whole picture.
 */
function buildAdvisorSummary() {
  const topCategories = [...state.picture.categories]
    .sort((a, b) => b.monthlyAverage - a.monthlyAverage)
    .slice(0, 6)
    .map((c) => ({ name: c.category, monthlyAverage: c.monthlyAverage, bucket: c.bucket }));

  return {
    safeToSpend: state.safeToSpend?.safeToSpend ?? null,
    safeToSpendStatus: state.safeToSpend?.status ?? null,
    reliableMonthlyIncome: state.income.reliable,
    monthlySurplus: state.coverage.fullSurplus,
    floorCoverageStatus: state.coverage.status,
    survivalMonthlyCost: state.picture.survivalMonthlyCost,
    trueMonthlyCost: state.picture.trueMonthlyCost,
    topCategories,
    subscriptionsAnnualCost: state.subs.totalAnnual,
    subscriptionCount: state.subs.subscriptions.length,
    priceIncreases: state.subs.priceIncreases.map((p) => ({
      payee: p.payee,
      changePercent: p.priceChange.changePercent,
      annualImpact: p.annualImpactOfIncrease,
    })),
    activeAlerts: [...state.alerts.urgent, ...state.alerts.inApp]
      .slice(0, 6)
      .map((a) => `${a.title}: ${a.body}`),
  };
}

/**
 * Recompute the alert set from whatever state is currently loaded.
 *
 * Deliberately tolerant of missing inputs — `state.bills` is empty until a
 * session exists, `state.subs` is empty until the demo/real transactions have
 * loaded — buildAlerts() treats every input as optional for exactly this
 * reason, so this can run early and often rather than waiting for everything.
 */
function refreshAlerts() {
  state.alerts = buildAlerts({
    bills: state.bills,
    transactions: state.transactions,
    subscriptions: state.subs,
    syncHealth: state.syncHealth,
    dismissed: state.dismissedAlerts,
  });
}

function dismissAlert(key) {
  state.dismissedAlerts.add(key);
  localStorage.setItem('dismissedAlerts', JSON.stringify([...state.dismissedAlerts]));
  refreshAlerts();
}

let paystubsModule = null;
async function loadPaystubs() {
  if (!paystubsModule) paystubsModule = await import('./paystubs.js');
  return paystubsModule;
}

/**
 * Reload paystubs and recompute reconciliations from source (each stub's own
 * period + that period's logged time entries) rather than round-tripping the
 * persisted summary — the DB only stores aggregate expected/actual figures,
 * not the per-line deduction detail learnFromHistory() needs to spot a
 * recurring deduction missing from the pay profile.
 */
async function refreshPaystubs() {
  state.paystubsError = null;
  if (!state.session || !state.householdId || !state.payProfile) return;

  try {
    const [paystubs, shifts] = await Promise.all([loadPaystubs(), loadShifts()]);
    state.paystubs = await paystubs.listPaystubs();

    const reconciliations = [];
    for (const stub of state.paystubs) {
      const entries = await shifts.listTimeEntries(stub.period.start, stub.period.end);
      const forecast = forecastPaycheck({
        profile: state.payProfile, entries, period: stub.period, payDate: stub.payDate,
      });
      reconciliations.push(reconcilePaycheck(forecast, stub));
    }
    state.reconciliations = reconciliations;
    state.learnedAdjustments = learnFromHistory(reconciliations);
  } catch (e) {
    state.paystubsError = e.message;
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

/** Which alerts a household has already seen, so they don't return every render. */
function loadDismissedAlerts() {
  try {
    return new Set(JSON.parse(localStorage.getItem('dismissedAlerts') ?? '[]'));
  } catch {
    return new Set();
  }
}

const state = {
  // True only for the brief window, on a browser that has signed in before,
  // between the demo fixture loading and the real session/data check
  // resolving — see hasPersistedSession(). Never shows the demo dashboard to
  // someone who very likely has real data coming; a plain loading state reads
  // as "getting your numbers", not as the app being wrong about them.
  bootLoading: false,
  transactions: [],
  streams: [],
  month: null,
  view: 'dashboard',
  learned: new Map(),
  syncHealth: null,
  dismissedAlerts: loadDismissedAlerts(),
  alerts: { alerts: [], urgent: [], inApp: [], toEmail: [] },
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
  advisorNotes: [],
  advisorAttempted: false,
  advisorBusy: false,
  advisorError: null,
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
  billFormOpen: false,
  billFormBusy: false,
  billFormError: null,
  billParseText: '',
  billDraft: { providerName: '', amountDue: '', dueDate: '', category: '' },
  paystubs: [],
  reconciliations: [],
  learnedAdjustments: null,
  paystubsError: null,
  paystubsAttempted: false,
  paystubBusy: false,
  paystubFormError: null,
  adjustmentsNotice: null,
  connectAttempted: false,
  authNotice: null,
  connectBusy: false,
  connectError: null,
  authError: null,
  safeToSpend: null,
  // Bills proposed from recurring charges in the household's own transactions.
  // `trackingBill` is the key of the one currently being saved, so only that
  // row shows a pending state rather than the whole list going dead.
  trackingBill: null,
  dismissedSuggestions: loadDismissedSuggestions(),
  // Budget targets the household set by hand, category -> monthly amount.
  // Everything else on the Budget tab is derived, so this is the only thing
  // that has to be remembered — and it's remembered for the household, not
  // for this browser (see refreshBudgetTargets).
  budgetTargets: {},
  budgetTargetsError: null,
  savingTarget: null,
  editingTarget: null,
  // Categories expanded in "Where it went". Kept in state because every
  // interaction inside one (setting a category, say) re-renders the whole
  // view, and a drilldown that slammed shut on every tap would be unusable.
  openCategories: new Set(),
  // Set when arriving at Transactions from a category, so the list opens on
  // that category instead of the whole month.
  transactionFilter: null,
  // Merchant logos are fetched from a public favicon service, which means a
  // request per merchant domain leaving this browser. On by default because
  // that is what makes the lists readable, off with one tap in More — a
  // display preference for this device, so localStorage is the right home for
  // it (unlike budget targets, which are a shared agreement).
  showLogos: localStorage.getItem('showLogos') !== '0',
  // Push reminders, per device. Read from the browser rather than stored,
  // because the browser is the authority: permission can be revoked in
  // settings without the app ever hearing about it.
  push: { supported: false, enabled: false, blocked: false },
  pushBusy: false,
  pushError: null,
  // The one transaction whose category picker is open, if any.
  editingCategory: null,
  // The transaction being split, the parts as typed so far, and the state of
  // saving them. The draft lives here rather than in the DOM because every
  // keystroke that changes the remainder re-renders the row.
  splitting: null,
  splitDraft: [],
  splitBusy: false,
  splitError: null,
  autoCategorizing: false,
  autoCategorizeResult: null,
  autoCategorizeError: null,
};

/**
 * Suggestions the household has waved off.
 *
 * Kept on the device rather than in the database on purpose: "not a bill" is
 * a judgement about one person's own list, it costs nothing to re-offer on a
 * new device, and it needs no round-trip to feel instant.
 */
function loadDismissedSuggestions() {
  try {
    return new Set(JSON.parse(localStorage.getItem('dismissedBillSuggestions') ?? '[]'));
  } catch {
    return new Set();
  }
}

function dismissSuggestion(key) {
  state.dismissedSuggestions.add(key);
  try {
    localStorage.setItem(
      'dismissedBillSuggestions',
      JSON.stringify([...state.dismissedSuggestions]),
    );
  } catch {
    /* A full or blocked localStorage must not break dismissing. */
  }
}

/**
 * Set or clear one target, for the whole household.
 *
 * Applied to the local state first and rendered immediately, then written —
 * typing a number and waiting on a round-trip to see it feels broken. If the
 * write fails the number is rolled back rather than left on screen as a
 * change the other phone will never see.
 */
async function setBudgetTarget(category, amount) {
  const previous = state.budgetTargets[category];
  if (amount === null) delete state.budgetTargets[category];
  else state.budgetTargets[category] = amount;

  state.budgetTargetsError = null;
  if (!state.session || !state.householdId) {
    // Demo numbers, nobody to share with. Kept for this session only, the
    // same way nothing else on the demo dashboard is written anywhere.
    return;
  }

  state.savingTarget = category;
  try {
    const mod = await loadBudgetTargetsModule();
    if (amount === null) await mod.clearBudgetTarget(state.householdId, category);
    else await mod.saveBudgetTarget(state.householdId, category, amount);
  } catch (e) {
    if (previous === undefined) delete state.budgetTargets[category];
    else state.budgetTargets[category] = previous;
    state.budgetTargetsError = `Couldn't save that target: ${e.message}`;
  } finally {
    state.savingTarget = null;
  }
}

const money = (n) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const moneyExact = (n) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// Only used for text the household typed themselves (an advisor question,
// not a payee/category pulled from a bank feed) — free-form input stored and
// re-rendered later has to be escaped before it goes back into innerHTML.
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

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

  // Account + transaction data is the only startup-critical payload.
  // Provider metadata, household members and invites are Connect-screen
  // details, so they hydrate in parallel instead of holding the whole app.
  const metadataPromise = Promise.all([
    connect.listProviderConnections(),
    connect.listMembers(),
    connect.listInvites(),
  ]);

  state.connectedItems = await connect.listConnectedItems();

  if (state.connectedItems.length) {
    try {
      await refreshRealTransactions(connect);
    } catch (e) {
      state.connectError = e.message;
    }
  }

  metadataPromise
    .then(([providerConnections, members, invites]) => {
      state.providerConnections = providerConnections;
      state.members = members;
      state.invites = invites;
      if (!state.bootLoading) render();
    })
    .catch((e) => {
      state.connectError = e.message;
      if (!state.bootLoading) render();
    });
} catch (e) {
  state.connectError = e.message;
  return;
}
}

/**
 * Replace the demo fixture with the household's actual transactions.
 * Real rows arrive already categorized and transfer/income-tagged by the
 * nightly sync (sync-transactions runs the same categorizeBatch/
 * detectTransfers/markIncome pipeline server-side), so unlike load()'s
 * fixture path this does not re-run that pipeline client-side — doing so
 * twice risked drifting from what the server already decided and persisted.
 */
async function refreshRealTransactions(connect) {
  const txns = await connect.listTransactions();

  state.transactions = txns;
  state.streams = detectIncomeStreams(txns);
  state.accounts = new Map(
    state.connectedItems.flatMap((item) => item.accounts ?? []).map((a) => [a.id, a]),
  );

  const months = [...new Set(txns.map((t) => monthKey(t.posted_date)))].sort();
  state.months = months;
  state.month = months.at(-1) ?? monthKey(new Date().toISOString());

  const loginRequiredItem = state.connectedItems.find((i) => i.status === 'login_required');
  const lastSyncTimes = state.connectedItems
    .map((i) => Date.parse(i.updated_at))
    .filter((t) => !Number.isNaN(t));
  state.syncHealth = {
    demo: false,
    status: loginRequiredItem ? 'login_required' : 'good',
    institution_name: loginRequiredItem?.institution_name,
    last_success: lastSyncTimes.length ? new Date(Math.min(...lastSyncTimes)).toISOString() : null,
  };

  buildPlan();
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
 * What's actually in the accounts, right now.
 *
 * Cash is checking and savings. Card balances are money already owed, not
 * money held, so they are reported separately rather than netted off — a
 * single blended figure hides which half is which, and the two numbers get
 * used for different decisions.
 *
 * The demo fixtures carry balances too, so the shape of this screen is the
 * same before a bank is connected as after.
 */
function cashOnHand() {
  const accounts = [...state.accounts.values()];
  let checking = 0;
  let savings = 0;
  let owed = 0;
  let accountCount = 0;

  // Two vocabularies land here: our own `account_type` enum from the database
  // ('checking' | 'savings' | 'credit' | …) and Plaid's shape in the demo
  // fixtures ('depository' plus a subtype). Both are read rather than
  // translated at the boundary, because a silent mismatch would show a
  // balance of $0 and look like an empty bank account.
  for (const a of accounts) {
    const type = a.type ?? '';
    const subtype = a.subtype ?? '';
    const balance = Number(a.current_balance ?? 0);
    if (!Number.isFinite(balance)) continue;

    if (type === 'credit') {
      owed += Math.abs(balance);
      continue;
    }
    if (type === 'savings' || subtype === 'savings') {
      savings += balance;
      accountCount += 1;
    } else if (type === 'checking' || type === 'depository') {
      checking += balance;
      accountCount += 1;
    }
  }

  // Savings is money the household has, but not money to spend this week —
  // so it counts toward "what we have" and never toward what's free to
  // spend. Blending the two is how an emergency fund gets spent on groceries
  // without anyone deciding to.
  return { checking, savings, owed, total: checking + savings, accountCount };
}

/**
 * Gather inputs for the Safe-to-Spend calculation from current state.
 * Returns null if critical inputs are missing (no variable income stream, no bills).
 */
function gatherSafeToSpendInputs() {
  if (!state.variableStream) return null;

  const currentBalance = cashOnHand().checking;

  // Pending outflows: recently authorized but not posted transactions.
  const pendingTxns = state.transactions.filter((t) => t.pending && t.amount > 0);
  const pendingOutflows = pendingTxns.reduce((sum, t) => sum + t.amount, 0);

  // Daily variable spending: average of groceries, fuel, dining from recent months.
  // These strings must match what the categorizer actually emits (see
  // src/engine/seed-rules.js) — a label that never occurs silently contributes
  // zero, which inflates safe-to-spend rather than failing visibly.
  const variableCategories = ['Groceries', 'Gas', 'Dining Out'];
  const recentMonths = state.months.slice(-3).filter((m) => m < state.month);
  let variableDailyTotal = 0;
  let variableDayCount = 0;

  for (const month of recentMonths) {
    const txns = spendingIn(month).filter((t) =>
      variableCategories.includes(t.category || '')
    );
    const monthTotal = txns.reduce((s, t) => s + t.amount, 0);
    const daysInMonth = new Date(+month.split('-')[0], +month.split('-')[1], 0).getDate();
    variableDailyTotal += monthTotal / daysInMonth;
    variableDayCount += 1;
  }
  const dailyVariableSpend = variableDayCount > 0 ? variableDailyTotal / variableDayCount : 0;

  // Sinking fund: irregular annual bills spread monthly.
  const sinkingFundContribution = state.picture?.monthly?.irregular ?? 0;

  // Emergency savings is a separate planning goal, not money that must be
  // rebuilt out of the cash on hand before every payday. The until-payday
  // number answers only what is already committed or reasonably expected
  // before the next check.
  const bufferTarget = 0;
  const bufferBalance = 0;

  // Income landing strictly BEFORE the horizon — never the paycheck that defines
  // it. The horizon is the variable stream's next_expected, so that check is what
  // the household is surviving until, not money available to survive on; counting
  // it inflates the headline by an amount that has not arrived.
  //
  // Other streams are a different matter. This household has a stable Meridian
  // paycheck as well as the variable Northstar one, and when Meridian lands
  // before the horizon it is genuinely spendable money — excluding it understates
  // the number just as surely as including the horizon check overstated it.
  //
  // Valued at the p20 floor rather than the typical amount, matching the
  // incomeBasis: 'floor' passed below: a better-than-usual check should make this
  // number rise later, never make it fall short now.
  const horizon = state.variableStream.next_expected;
  const today = new Date().toISOString().slice(0, 10);
  const expectedIncomeBeforePayday = (state.streams ?? [])
    .filter((s) => s !== state.variableStream
      && s.next_expected
      && s.next_expected >= today
      && s.next_expected < horizon)
    .reduce((sum, s) => sum + (s.distribution?.floor ?? 0), 0);

  return {
    currentBalance,
    pendingOutflows: pendingOutflows > 0 ? pendingOutflows : 0,
    bills: state.bills,
    dailyVariableSpend: Math.max(0, dailyVariableSpend),
    bufferTarget,
    bufferBalance,
    savingsGoals: [],
    sinkingFundContribution,
    nextPayday: state.variableStream.next_expected,
    expectedIncomeBeforePayday,
    incomeBasis: 'floor',
  };
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

  const stsInputs = gatherSafeToSpendInputs();
  state.safeToSpend = stsInputs ? calculateSafeToSpend(stsInputs) : null;

  refreshAlerts();
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
      !isSplitParent(t, parents),
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

// ---------------------------------------------------------------------------
// UI primitives
//
// Every screen builds from these. Before, each view invented its own row, its
// own button styling and its own inline CSS, so the same information looked
// different depending on which tab you happened to be on — the single biggest
// reason the app read as several apps stapled together. There is now one row,
// one button scale, one field, one avatar.
// ---------------------------------------------------------------------------

/**
 * Line icons, drawn at 1.6px stroke in currentColor.
 *
 * Inline SVG rather than an emoji or a unicode glyph: those render differently
 * on every platform (and some, like ＄ and •••, are visibly not from the same
 * family as each other), which is exactly the kind of small incoherence that
 * makes an interface feel assembled rather than designed.
 */
const ICONS = {
  home: '<path d="M3 9.5 10 4l7 5.5V16a1 1 0 0 1-1 1h-3.5v-4.5h-5V17H4a1 1 0 0 1-1-1z"/>',
  bills: '<path d="M4.5 3h11v14l-2.2-1.4L11 17l-2.3-1.4L6.4 17l-1.9-1.2z"/><path d="M7.5 7.5h5M7.5 11h3.5"/>',
  spending: '<path d="M3 15.5 7.5 10l3.2 3 5.3-6.5"/><path d="M12.5 6.5H16V10"/>',
  budget: '<rect x="2.5" y="5.5" width="15" height="10" rx="2"/><path d="M2.5 9h15"/><path d="M13 12.5h2"/>',
  income: '<path d="M10 3.5v13"/><path d="M13.2 6.2A3 3 0 0 0 10.4 4.5h-.8a2.6 2.6 0 0 0-.4 5.2l1.6.3a2.6 2.6 0 0 1-.4 5.2h-.8a3 3 0 0 1-2.8-1.7"/>',
  more: '<circle cx="5" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.3" fill="currentColor" stroke="none"/>',
  chevron: '<path d="M7.5 4.5 13 10l-5.5 5.5"/>',
  back: '<path d="M12.5 4.5 7 10l5.5 5.5"/>',
  plus: '<path d="M10 4.5v11M4.5 10h11"/>',
  search: '<circle cx="9" cy="9" r="5"/><path d="M12.8 12.8 16.5 16.5"/>',
  settings: '<circle cx="10" cy="10" r="2.5"/><path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1 4.7 4.7"/>',
  bank: '<path d="M3 8 10 4l7 4"/><path d="M4.5 8v7M8 8v7M12 8v7M15.5 8v7"/><path d="M3 16.5h14"/>',
  mail: '<rect x="3" y="5" width="14" height="10" rx="1.5"/><path d="m3.5 6 6.5 5 6.5-5"/>',
  sparkle: '<path d="M10 3.5 11.6 8 16 9.6 11.6 11.2 10 15.7 8.4 11.2 4 9.6 8.4 8z"/>',
  check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
  clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4.3l2.8 1.7"/>',
  calendar: '<rect x="3" y="4.5" width="14" height="12.5" rx="1.5"/><path d="M3 8.5h14M7 3v3M13 3v3"/>',
  repeat: '<path d="M4 9.2V8a3 3 0 0 1 3-3h7"/><path d="m11.5 2.5 2.5 2.5-2.5 2.5"/><path d="M16 10.8V12a3 3 0 0 1-3 3H6"/><path d="m8.5 17.5-2.5-2.5 2.5-2.5"/>',
  trend: '<path d="M3.5 16.5v-6M8.5 16.5v-11M13.5 16.5v-8"/>',
  list: '<path d="M6.5 5.5h10M6.5 10h10M6.5 14.5h10M3.5 5.5h.01M3.5 10h.01M3.5 14.5h.01"/>',
  people: '<circle cx="8" cy="7.5" r="2.8"/><path d="M3 16.5a5 5 0 0 1 10 0"/><path d="M13.5 5.2a2.8 2.8 0 0 1 0 5.4M14.5 16.5a5 5 0 0 0-1.6-3.7"/>',
  inbox: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M3 11.5h3.5l1 2h5l1-2H17"/>',
};

function icon(name, size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none"
    stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}

/**
 * A colored initial for a payee.
 *
 * Same name always gets the same color — a household recognizes "the orange
 * one" long before they read the label, and a color that shuffled between
 * renders would make the list feel unstable.
 */
function avatarFor(name, logos = null) {
  const label = (name || '?').trim();
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  const letter = escapeHtml(label.charAt(0).toUpperCase() || '?');

  const sources = (Array.isArray(logos) ? logos : [logos]).filter(Boolean)
    .filter((url) => !deadLogos.has(url));
  if (!sources.length) return `<div class="row-avatar av-${hash % 6}">${letter}</div>`;

  // The initial is the base layer and the logo paints on top of it, rather
  // than the logo being swapped out for the initial when it fails. These URLs
  // are somebody else's CDN: they can 404, they can be blocked by a network,
  // and they can simply hang. Only the first of those fires an error event, so
  // anything built on swapping leaves an empty plate in the other two cases —
  // which looks more broken than no logo at all. This way the row is complete
  // and readable before the image resolves, and stays that way if it never does.
  const [first, ...rest] = sources;
  return `<span class="row-avatar av-${hash % 6} has-logo">${letter}<img
    src="${escapeHtml(first)}" alt="" loading="lazy" referrerpolicy="no-referrer"
    data-next="${escapeHtml(rest.join(' '))}"
    onload="this.classList.add('loaded')" onerror="window.__logoFailed(this)" /></span>`;
}

/**
 * Logo URLs that have already failed once, so a re-render doesn't ask for
 * them again. A blocked host fails for every row at once; without this the
 * app would re-request a hundred images it already knows are unreachable
 * every time a category is opened or a transaction is recategorized.
 */
const deadLogos = new Set();

/**
 * Move an <img> to its next source, or give up and leave the initial.
 *
 * On window because it is called from an inline onerror: the handler has to
 * exist at parse time for images that fail before any listener could be
 * attached — a cached 404 fires its error event immediately.
 */
window.__logoFailed = (img) => {
  const next = (img.dataset.next || '').split(' ').filter(Boolean);
  deadLogos.add(img.src);
  if (!next.length) {
    img.remove();
    return;
  }
  img.dataset.next = next.slice(1).join(' ');
  img.src = next[0];
};

/**
 * Logos by payee, so anything that knows a payee name can show its logo —
 * bills included, which have no logo of their own but are nearly always paid
 * to a merchant the transaction feed has already seen.
 */
let logoIndexCache = { source: null, map: new Map() };
function logoIndex() {
  // Rebuilt only when the transaction list itself changes — this is called
  // once per row, and a fresh scan per row is a scan per row too many.
  if (logoIndexCache.source === state.transactions) return logoIndexCache.map;
  const map = new Map();
  for (const t of state.transactions) {
    // Plaid's own logo first when it gave us one, then the derived sources.
    const sources = [
      t.logo_url,
      ...logoSources(domainForPayee(t.payee, t.merchant_website)),
    ].filter(Boolean);
    if (sources.length && !map.has(t.payee)) map.set(t.payee, sources);
  }
  logoIndexCache = { source: state.transactions, map };
  return map;
}

/**
 * A logo for anything that knows a payee name — transactions, bills,
 * subscriptions, income.
 *
 * Bills have no logo of their own but are nearly always paid to a merchant the
 * transaction feed has already seen, so they look there first and fall back to
 * deriving a domain from the provider name directly.
 */
function logoForPayee(payee) {
  if (!payee || !state.showLogos) return null;

  const index = logoIndex();
  if (index.has(payee)) return index.get(payee);

  // Bill providers and payees rarely match character for character
  // ("PG&E" vs "PGANDE WEB ONLINE"), so try the leading word.
  const stem = payeeStem(payee);
  if (stem) {
    for (const [name, sources] of index) {
      if (payeeStem(name) === stem) return sources;
    }
  }
  return logoSources(domainForPayee(payee));
}

/**
 * The one list row. Slots, all optional except title:
 *   avatar | title (+ chips) | sub | amount | amountSub | chevron | actions
 */
function row({
  avatar, logo = null, iconName, title, sub, amount, amountSub, amountClass = '',
  chips = '', chevron = false, actions = '', tone = '', attrs = '', tag = 'div',
}) {
  const lead = avatar
    ? avatarFor(avatar, logo)
    : iconName ? `<div class="row-avatar ghost">${icon(iconName, 17)}</div>` : '';

  const inner = `
    ${lead}
    <div class="row-body">
      <div class="row-title">${title}${chips}</div>
      ${sub ? `<div class="row-sub">${sub}</div>` : ''}
    </div>
    ${amount != null ? `
      <div class="row-end">
        <div class="row-amount ${amountClass}">${amount}</div>
        ${amountSub ? `<div class="row-amount-sub">${amountSub}</div>` : ''}
      </div>` : ''}
    ${chevron ? `<span class="row-chev">${icon('chevron', 16)}</span>` : ''}
  `;

  // Actions push the row into a stacked layout — buttons crammed onto the same
  // line as an amount make both harder to hit and harder to read.
  if (actions) {
    return `<div class="row row-stack ${tone}" ${attrs}>
      <div style="display:flex;align-items:center;gap:12px;">${inner}</div>
      <div class="row-actions">${actions}</div>
    </div>`;
  }
  return `<${tag} class="row ${tone}" ${attrs}>${inner}</${tag}>`;
}

/** Section wrapper: title, optional subtitle, optional right-hand action. */
function section(title, body, { sub = '', action = '' } = {}) {
  return `
    <section class="section">
      <div class="section-head">
        <div>
          <div class="section-title">${title}</div>
          ${sub ? `<div class="section-sub">${sub}</div>` : ''}
        </div>
        ${action}
      </div>
      ${body}
    </section>
  `;
}

/** Sub-navigation inside one primary tab. */
function segmented(items) {
  return `
    <div class="seg">
      ${items.map(([view, label]) => `
        <button class="seg-btn ${state.view === view ? 'active' : ''}" data-view="${view}">${label}</button>
      `).join('')}
    </div>
  `;
}

function emptyState({ iconName = 'inbox', title, body = '', action = '' }) {
  return `
    <div class="empty">
      <div class="empty-icon">${icon(iconName, 26)}</div>
      <div class="empty-title">${title}</div>
      ${body ? `<div class="empty-body">${body}</div>` : ''}
      ${action}
    </div>
  `;
}

/** Shown wherever a view needs a session the household hasn't started yet. */
function signInPrompt(what) {
  return emptyState({
    iconName: 'people',
    title: `Sign in to ${what}`,
    body: 'This is shared across the household, so it lives in the database rather than on one phone.',
    action: '<button class="btn btn-primary" data-view="connect">Go to sign in</button>',
  });
}

/**
 * The five primary tabs, and which views each owns.
 *
 * docs/ui/README.md's five-section IA (Home / Bills / Spending / Income /
 * More) groups this app's views rather than mapping one tab to one view.
 * Tapping a tab lands on its first view; siblings are reached by a segmented
 * control at the top of that tab, NOT by a menu — the old "More" screen listed
 * ten destinations of wildly different importance as ten identical rows, which
 * is how Trends, Paystubs and Connect all ended up equally buried.
 *
 * The tab bar highlights the owning group whichever sibling is open, so
 * moving between them never reads as leaving the section.
 */
const NAV_GROUPS = [
  { id: 'dashboard', label: 'Home', icon: 'home', views: ['dashboard'] },
  { id: 'budget', label: 'Budget', icon: 'budget', views: ['budget', 'bills'] },
  { id: 'spending', label: 'Spending', icon: 'spending', views: ['spending', 'transactions', 'review', 'year'] },
  { id: 'income', label: 'Income', icon: 'income', views: ['income', 'paycheck', 'shifts', 'paystubs'] },
  { id: 'more', label: 'More', icon: 'more', views: ['more', 'connect', 'advisor', 'plan', 'subscriptions', 'trends'] },
];

/**
 * Sub-navigation for the tabs that own more than one view.
 *
 * Spending is deliberately down to two. It carried four — Overview,
 * Transactions, Recurring, Trends — and the overview itself opened on
 * "Surplus on a slow stretch" over a committed/necessary/discretionary/
 * irregular table, which is an accounting model, not a question anybody
 * asks. What's left answers "what did we spend, and on what", with the two
 * analytical screens moved to More where an occasional destination belongs.
 */
const SPENDING_TABS = [
  ['spending', 'Month'],
  ['transactions', 'Transactions'],
  ['year', 'Year'],
];

/** The plan, and the bills it's mostly made of. */
const BUDGET_TABS = [
  ['budget', 'Budget'],
  ['bills', 'Bills'],
];
const INCOME_TABS = [
  ['income', 'Overview'],
  ['paycheck', 'Paycheck'],
  ['shifts', 'Shifts'],
  ['paystubs', 'Paystubs'],
];

function uncategorizedCount() {
  return state.transactions.filter((t) => !t.category && !t.is_transfer && !t.is_income && !t.pending).length;
}

function renderBottomNav() {
  const dots = {
    budget: state.billsNeedingReview.length > 0,
    spending: uncategorizedCount() > 0,
  };

  return `
    <nav class="tabbar">
      ${NAV_GROUPS.map((g) => `
        <button class="tab ${g.views.includes(state.view) ? 'active' : ''}" data-view="${g.id}">
          <span class="tab-icon">${icon(g.icon, 21)}</span>
          ${g.label}
          ${dots[g.id] ? '<span class="tab-dot"></span>' : ''}
        </button>
      `).join('')}
    </nav>
  `;
}

/**
 * Settings and the occasional destination — not a dumping ground for views
 * that belong on a real tab. Everything with a home somewhere else moved
 * there; what's left is genuinely peripheral.
 */
function renderMore() {
  const rows = [
    ['subscriptions', 'Recurring & subscriptions', 'repeat', 'What renews, and what it costs per year'],
    ['trends', 'Trends', 'trend', 'Category by category, month by month'],
    ['connect', 'Accounts & sync', 'bank', state.connectedItems.length
      ? `${state.connectedItems.length} connected` : 'No bank connected'],
    ['advisor', 'Advisor', 'sparkle', state.advisorNotes.length
      ? `${state.advisorNotes.length} check-in${state.advisorNotes.length === 1 ? '' : 's'}` : 'Ask about your numbers'],
    ['plan', 'Long-term plan', 'trend', 'Priorities, debt, the child transition'],
  ];

  return `
    ${section('More', `
      <div class="list">
        ${rows.map(([id, label, iconName, sub]) => row({
          iconName, title: label, sub, chevron: true,
          tag: 'button', attrs: `data-view="${id}"`,
        })).join('')}
      </div>
    `)}

    ${section('Reminders', `
      <div class="list">
        ${row({
          iconName: 'mail',
          title: 'Bill reminders on this device',
          sub: !state.session
            ? 'Sign in to turn these on.'
            : state.push.blocked
              ? 'Blocked in your browser settings — they have to be turned back on there first.'
              : !state.push.supported
                ? 'This browser cannot show them. On iPhone, add the app to your home screen first.'
                : state.push.enabled
                  ? 'On — a bill due soon, or one you are short for, buzzes this device.'
                  : 'Off — reminders only arrive by email at the daily sync.',
          actions: state.session && state.push.supported && !state.push.blocked
            ? `<button class="btn btn-sm ${state.push.enabled ? 'btn-outline' : 'btn-primary'}"
                 data-action="toggle-push" ${state.pushBusy ? 'disabled' : ''}>
                 ${state.pushBusy ? '…' : state.push.enabled ? 'Turn off' : 'Turn on'}
               </button>`
            : '',
        })}
      </div>
      ${state.pushError ? `<div class="field-hint" style="color:var(--negative);margin-top:8px;">${escapeHtml(state.pushError)}</div>` : ''}
      <div class="prose-sm" style="margin-top:9px;">
        Each device is separate — turning these on here doesn't turn them on
        anywhere else, and only the urgent ones are sent: a bill due within
        days, or one the account can't cover.
      </div>
    `)}

    ${section('Display', `
      <div class="list">
        ${row({
          iconName: 'bank',
          title: 'Show merchant logos',
          sub: state.showLogos
            ? 'On — matched from the merchant name, so the occasional one is wrong or missing. Fetched from Google\'s public favicon service, which means it sees the merchant domains this device looks up (not your amounts, transactions, or who you are).'
            : 'Off — coloured initials only, and nothing leaves this device.',
          actions: `<button class="btn btn-sm btn-outline" data-action="toggle-logos">
            ${state.showLogos ? 'Turn off' : 'Turn on'}
          </button>`,
        })}
      </div>
    `)}

    ${section('This household', `
      <div class="list">
        ${state.session
          ? row({
            iconName: 'people',
            title: escapeHtml(state.session.user.email),
            sub: 'Signed in',
            actions: '<button class="btn btn-sm btn-outline" data-action="sign-out">Sign out</button>',
          })
          : row({
            iconName: 'people', title: 'Not signed in',
            sub: 'The app is showing demo numbers', chevron: true,
            tag: 'button', attrs: 'data-view="connect"',
          })}
      </div>
    `)}

    <div class="disclaimer">
      Every figure here is computed from your own transactions. Nothing is
      advice, and nothing leaves this household except the aggregate summary
      the advisor is given when you ask it for a check-in.
    </div>
  `;
}

function renderSyncBanner() {
  const health = state.syncHealth;
  if (!health) return '';

  if (health.demo) {
    return `<div class="banner">
      <div class="banner-body">
        <strong>Demo numbers.</strong>
        Nothing here is real yet — connect a bank to see your own.
      </div>
      <button class="linkbtn" data-view="connect">Connect</button>
    </div>`;
  }

  if (health.status === 'login_required') {
    return `<div class="banner banner-warn">
      <div class="banner-body">
        <strong>${health.institution_name} needs reconnecting.</strong>
        Your bank ended the connection — this happens a few times a year.
      </div>
      <button class="linkbtn" data-action="reauth">Reconnect</button>
    </div>`;
  }

  // A dashboard rendering stale numbers looks exactly like a working one.
  // Staleness has to be visible or it isn't caught.
  const hours = (Date.now() - new Date(health.last_success).getTime()) / 3600000;
  if (hours > 48) {
    return `<div class="banner banner-warn">
      <div class="banner-body">
        Last synced ${Math.floor(hours / 24)} days ago — these numbers may be out of date.
      </div>
    </div>`;
  }
  return '';
}

/**
 * Alerts, most urgent first. Lives at the top of the Dashboard rather than
 * globally above the nav — a notification center belongs at the front door,
 * not repeated on every tab.
 */
/**
 * One alert visible by default, the rest behind a fold.
 *
 * Two or three full banners stacked at the top of the dashboard, every
 * time, is exactly the kind of always-on noise a household stops reading —
 * and once the real one (the sync is stale, a bill needs reconnecting)
 * blends into that noise, it's as good as invisible. Leading with the single
 * most relevant item and folding the rest keeps the urgent case legible.
 */
function renderAlerts() {
  const items = [...state.alerts.urgent, ...state.alerts.inApp.filter((a) => !a.urgent)];
  if (!items.length) return '';

  const renderOne = (a) => `
    <div class="banner ${a.urgent ? 'banner-warn' : ''}">
      <div class="banner-body">
        <strong>${a.title}</strong>
        <div>${a.body}</div>
      </div>
      <button class="linkbtn quiet" data-action="dismiss-alert" data-key="${a.key}">Dismiss</button>
    </div>
  `;

  const [first, ...rest] = items;

  return `
    ${renderOne(first)}
    ${rest.length ? `
      <details class="fold" style="margin:-4px 0 14px;">
        <summary>${rest.length} more ${rest.length === 1 ? 'insight' : 'insights'}</summary>
        <div class="fold-body">${rest.map(renderOne).join('')}</div>
      </details>
    ` : ''}
  `;
}

/** Categories shown before "Where it went" folds the rest behind a tap. */
const CATEGORY_LIST_LIMIT = 5;

function renderCategoryRows(categories, max) {
  const txns = spendingIn(state.month);

  return categories.map(([name, amount]) => {
    const avg = trailingAverage(name);
    const delta = avg ? ((amount - avg) / avg) * 100 : 0;
    const showDelta = avg !== null && Math.abs(delta) > 15;
    const rows = txns
      .filter((t) => (t.category || 'Uncategorized') === name)
      .sort((a, b) => b.posted_date.localeCompare(a.posted_date));

    // A <details>, not a link to another screen: "Groceries $612" is the
    // start of a question and the answer is right there underneath it.
    // Opening one keeps the rest of the month on screen, and closing it puts
    // you back exactly where you were — which a separate page never does.
    return `
      <details class="row cat-row" ${state.openCategories.has(name) ? 'open' : ''} data-category="${escapeHtml(name)}">
        <summary>
          <div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;">
            <span class="row-title">${name}</span>
            <span class="row-amount">${moneyExact(amount)}</span>
          </div>
          <div class="row-sub" style="margin-top:2px;">
            ${rows.length} transaction${rows.length === 1 ? '' : 's'}
          </div>
          <div class="meter">
            <div class="meter-fill ${name === 'Uncategorized' ? 'quiet' : ''}" style="width:${Math.min(100, (amount / max) * 100)}%"></div>
          </div>
          ${showDelta ? `
            <div class="row-sub" style="margin-top:7px;color:${delta > 0 ? 'var(--negative)' : 'var(--positive)'};">
              ${delta > 0 ? '↑' : '↓'} ${Math.abs(Math.round(delta))}% vs recent average
            </div>` : ''}
        </summary>
        <div class="cat-body">
          ${rows.map(renderTransactionRow).join('')}
        </div>
      </details>
    `;
  }).join('');
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

  const cash = cashOnHand();

  // The same until-payday arithmetic as before, now shown as a supporting
  // line under the balance rather than as the headline. "Safe to spend" was
  // the app's own coinage and meant nothing to the people using it; the
  // number is still useful, the name was not.
  const sts = gatherSafeToSpendInputs();
  const safeToSpendResult = sts ? calculateSafeToSpend(sts) : null;

  const reviewCount = uncategorizedCount();

  return `
    ${renderAlerts()}
    ${renderHouseholdPrompt()}

    <div class="month-picker">
      <button class="chev-btn" data-month-step="-1" ${state.months.indexOf(state.month) <= 0 ? 'disabled' : ''}>${icon('back', 16)}</button>
      <div class="month-picker-label">${monthLabel(state.month)}</div>
      <button class="chev-btn" data-month-step="1" ${state.months.indexOf(state.month) >= state.months.length - 1 ? 'disabled' : ''}>${icon('chevron', 16)}</button>
    </div>

    <div class="hero">
      <div class="hero-label">Money in the bank</div>
      <div class="hero-value">${moneyExact(cash.total)}</div>
      <div class="hero-note">
        ${cash.accountCount
          ? `Across ${cash.accountCount} account${cash.accountCount === 1 ? '' : 's'}, as of the last sync.`
          : 'No bank connected yet — connect one and your real balance shows here.'}
      </div>
      ${cash.accountCount ? `
        <div class="hero-foot">
          <span><b>${money(cash.checking)}</b> in checking</span>
          ${cash.savings > 0 ? `<span><b>${money(cash.savings)}</b> in savings</span>` : ''}
          ${cash.owed > 0 ? `<span><b>${money(cash.owed)}</b> owed on cards</span>` : ''}
        </div>` : ''}
    </div>

    ${safeToSpendResult ? `
      <div class="card" style="margin-to…16768 tokens truncated…Hours}h worked` : '',
              e.callbackEvents ? `${e.callbackEvents} callout${e.callbackEvents > 1 ? 's' : ''} (${e.callbackHours}h)` : '',
              e.standbyHours ? `${e.standbyHours}h standby` : '',
              e.holidayHours ? `${e.holidayHours}h holiday` : '',
              e.ptoHours ? `${e.ptoHours}h PTO` : '',
            ].filter(Boolean).join(' · '),
            actions: `<button class="btn btn-sm btn-outline" data-action="delete-shift" data-id="${e.id}">Remove</button>`,
          })).join('')}
        </div>`)}

    <div class="disclaimer">
      An estimate from the hours logged here, not a promise from your employer.
      Enter a real paystub once one arrives and the app corrects its own tax
      assumptions against it.
    </div>`;
}

/** Where a bill came from, as the small badge docs/ui/README.md asks for. */
const BILL_SOURCE_LABEL = {
  email: 'Email', bank: 'Bank', manual: 'Manual',
  pdf: 'PDF', provider_api: 'Provider', provider_portal: 'Portal',
};

function renderBillRow(b) {
  const days = daysUntilDue({ dueDate: b.dueDate });
  const due = new Date(`${b.dueDate}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const when = days < 0 ? `${Math.abs(days)}d overdue`
    : days === 0 ? 'Due today'
    : days === 1 ? 'Due tomorrow'
    : `Due ${due}`;

  return row({
    avatar: b.providerName,
    logo: logoForPayee(b.providerName),
    title: b.providerName,
    chips: `<span class="chip ${BILL_SOURCE_LABEL[b.source] ? 'chip-outline' : ''}">${BILL_SOURCE_LABEL[b.source] ?? b.source}</span>`,
    sub: `${when} · ${b.category}`,
    amount: moneyExact(b.amountDue),
    amountSub: days >= 0 && days <= 7 ? `in ${days}d` : '',
    tone: days < 0 ? 'warn' : '',
  });
}

/**
 * Bills grouped by which specific upcoming paycheck needs to cover them —
 * the question "which check do I need this money in hand by", not the
 * dashboard's already-answered "how much total is due this month". Streams
 * come from bank deposit history (state.streams), so this works whether or
 * not a pay profile/timecard is set up — Shifts sharpens the paycheck
 * *amount* forecast, not whether this grouping exists at all.
 */
function renderBillsByPaycheck(bills) {
  const plan = planPaycheckCoverage(bills, state.streams);
  const coveredGroups = plan.groups.filter((g) => g.bills.length);
  const noPaydaysKnown = plan.groups.length === 0;

  const group = (label, total, list) => `
    <div style="margin-top:14px;">
      <div class="section-head" style="margin-bottom:8px;">
        <div class="section-sub" style="margin:0;"><strong style="color:var(--text);">${label}</strong></div>
        <div class="row-amount">${moneyExact(total)}</div>
      </div>
      <div class="list">${list.map((b) => renderBillRow(b)).join('')}</div>
    </div>
  `;

  return section('Which check covers what', `
    ${plan.dueNow.bills.length
      ? group(
        noPaydaysKnown ? 'No income pattern detected yet' : 'Due before your next check',
        plan.dueNow.total, plan.dueNow.bills,
      )
      : ''}

    ${coveredGroups.map((g) => group(
      `Save from your ${new Date(`${g.paycheckDate}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} check`,
      g.total, g.bills,
    )).join('')}

    ${plan.later.bills.length ? `
      <details class="fold">
        <summary>${plan.later.bills.length} further out — ${moneyExact(plan.later.total)}</summary>
        <div class="fold-body list">${plan.later.bills.map((b) => renderBillRow(b)).join('')}</div>
      </details>
    ` : ''}
  `, {
    sub: 'The specific paycheck that has to cover it by its due date',
  });
}

/**
 * Bills the household already pays, spotted in their own transactions.
 *
 * The whole point of this section is that it needs nothing from anybody — no
 * inbox to connect, no form to fill in. Everything shown here is a charge that
 * has already cleared this account on a rhythm, so accepting one is a
 * confirmation, not data entry.
 */
/**
 * How many bills the app could track without being told anything.
 *
 * Used by the Budget tab's empty state, which is otherwise a dead end: it
 * says "no bills" on a screen whose whole job is bills, while the app is
 * already sitting on a list of them.
 */
function billSuggestionCount() {
  const recurring = [...(state.subs?.bills ?? []), ...(state.subs?.subscriptions ?? [])];
  return suggestBillsFromTransactions({
    streams: recurring,
    bills: [...state.bills, ...state.billsNeedingReview],
  }).filter((s) => !state.dismissedSuggestions.has(s.key)).length;
}

function renderBillSuggestions() {
  const recurring = [...(state.subs?.bills ?? []), ...(state.subs?.subscriptions ?? [])];
  const suggestions = suggestBillsFromTransactions({
    streams: recurring,
    bills: [...state.bills, ...state.billsNeedingReview],
  }).filter((s) => !state.dismissedSuggestions.has(s.key));

  if (!suggestions.length) return '';

  const shown = suggestions.slice(0, 6);

  // Tracking them one at a time is fine for the odd new subscription, but on
  // first use the list is the household's entire set of bills — rent,
  // childcare, insurance, the utilities — and six taps with a confirmation
  // each is how a setup step gets abandoned half-done.
  const confident = suggestions.filter((x) => !x.stale);

  return section('Found in your transactions', `
    ${confident.length > 1 ? `
      <div class="card" style="margin-bottom:10px;">
        <div class="card-head">
          <span class="card-title">Track these as bills</span>
          <button class="btn btn-sm btn-primary" data-action="track-all-bills"
            ${state.trackingBill ? 'disabled' : ''}>
            ${state.trackingBill === '*' ? 'Adding…' : `Track all ${confident.length}`}
          </button>
        </div>
        <div class="prose-sm" style="margin-top:6px;">
          Each of these is a charge that has already cleared this account on a
          rhythm. Tracking them is what makes the Budget tab show real bills
          instead of guessing from categories — and you can drop any of them
          afterwards.
        </div>
      </div>` : ''}

    <div class="list">
      ${shown.map((s) => {
        const busy = state.trackingBill === s.key;
        const due = new Date(`${s.dueDate}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return row({
          avatar: s.providerName,
          logo: logoForPayee(s.providerName),
          title: s.providerName,
          chips: [
            s.amountVaries ? '<span class="chip chip-warn">varies</span>' : '',
            s.stale ? '<span class="chip">may have stopped</span>' : '',
          ].join(''),
          sub: `${s.reason} · next expected ${due}`,
          amount: moneyExact(s.amountDue),
          amountSub: s.category,
          actions: `
            <button class="btn btn-sm btn-primary" data-action="track-bill" data-key="${s.key}" ${busy ? 'disabled' : ''}>
              ${busy ? 'Adding…' : 'Track as bill'}
            </button>
            <button class="btn btn-sm btn-outline" data-action="dismiss-suggestion" data-key="${s.key}" ${busy ? 'disabled' : ''}>
              Not a bill
            </button>
          `,
        });
      }).join('')}
    </div>
    ${suggestions.length > shown.length
      ? `<div class="prose-sm" style="margin-top:10px;">${suggestions.length - shown.length} more will appear as you clear these.</div>`
      : ''}
  `, {
    sub: `${suggestions.length} recurring charge${suggestions.length === 1 ? '' : 's'} you're already paying`,
  });
}

/**
 * Bills detected from Gmail. Plaid shows a payment after it lands; a bill is
 * the one piece of information the household needs *before* that, which is
 * the entire reason this exists rather than waiting for the bank feed.
 */
function renderBills() {
  if (!state.session) return `${segmented(BUDGET_TABS)}${signInPrompt('see bills')}`;

  if (state.billsError) {
    return `${segmented(BUDGET_TABS)}
      <div class="banner banner-warn"><div class="banner-body">${state.billsError}</div></div>`;
  }

  const review = state.billsNeedingReview;
  const bills = state.bills;
  const dueThisMonth = bills.filter((b) => monthKey(b.dueDate) === monthKey(new Date().toISOString()));
  const monthTotal = dueThisMonth.reduce((s, b) => s + b.amountDue, 0);
  const gmailConnected = state.providerConnections.some(
    (c) => c.provider_key === 'gmail' && c.status !== 'disconnected',
  );

  return `
    ${segmented(BUDGET_TABS)}
    ${bills.length ? `
      <div class="hero">
        <div class="hero-label">Due this month</div>
        <div class="hero-value">${moneyExact(monthTotal)}</div>
        <div class="hero-note">
          Across ${dueThisMonth.length} bill${dueThisMonth.length === 1 ? '' : 's'}${bills.length > dueThisMonth.length
            ? `, plus ${bills.length - dueThisMonth.length} further out` : ''}.
        </div>
      </div>
    ` : ''}

    ${review.length ? section(`Needs review`, `
      <div class="list">
        ${review.map((b) => row({
          avatar: b.providerName,
          logo: logoForPayee(b.providerName),
          title: b.providerName,
          chips: `<span class="chip chip-warn">${Math.round(b.confidence * 100)}% sure</span>`,
          sub: `Due ${b.dueDate} · ${BILL_SOURCE_LABEL[b.source] ?? b.source}`,
          amount: moneyExact(b.amountDue),
          actions: `
            <button class="btn btn-sm btn-primary" data-action="confirm-bill" data-id="${b.id}">Confirm</button>
            <button class="btn btn-sm btn-outline" data-action="dismiss-bill" data-id="${b.id}">Not a bill</button>
          `,
        })).join('')}
      </div>
    `, {
      sub: 'Parsed with low confidence — confirm before it counts toward what\'s due',
    }) : ''}

    ${/* With nothing tracked yet, the suggestions ARE the tab — putting the
          paycheck grouping first would lead with an empty table above the
          only actionable thing on screen. */ ''}
    ${bills.length ? renderBillsByPaycheck(bills) : ''}

    ${renderBillSuggestions()}

    ${bills.length === 0 && billSuggestionCount() === 0 ? section('Upcoming bills', emptyState({
      iconName: 'bills',
      title: 'No bills tracked yet',
      body: gmailConnected
        ? 'Nothing found in your email yet — the next daily scan may pick some up. You can also add one by hand.'
        : 'Connect Gmail to find them automatically, or add one by hand below.',
      action: gmailConnected ? '' : '<button class="btn btn-secondary" data-view="connect">Connect Gmail</button>',
    })) : ''}

    ${renderAddBillForm()}
  `;
}

const BILL_CATEGORIES = SEED_CATEGORIES.filter(([, , kind]) => kind !== 'income' && kind !== 'transfer');

/**
 * Add a bill by hand — always available, unlike the rest of the Bills tab,
 * which needs Gmail connected. The "paste text" box is optional: providing
 * it and clicking "Fill in with AI" pre-fills the fields below via
 * parse-bill-text (Gemini), but every field stays a plain editable input, so
 * typing them directly with no AI involved at all works exactly the same.
 */
function renderAddBillForm() {
  const d = state.billDraft;
  const busy = state.billFormBusy ? 'disabled' : '';

  if (!state.billFormOpen) {
    return `
      <div style="margin-top:20px;">
        <button class="btn btn-outline btn-block" data-action="toggle-bill-form">
          ${icon('plus', 16)} Add a bill by hand
        </button>
      </div>
    `;
  }

  return section('Add a bill', `
    ${state.billFormError ? `<div class="banner banner-warn"><div class="banner-body">${state.billFormError}</div></div>` : ''}

    <div class="card">
      <label class="field">
        <span class="field-label">Paste bill text (optional)</span>
        <textarea class="textarea" id="bill-parse-text" rows="3"
          placeholder="A bill email, a portal page, a screenshot transcript…" ${busy}>${escapeHtml(state.billParseText)}</textarea>
      </label>
      <button data-action="parse-bill-text" class="btn btn-secondary btn-block" style="margin-top:10px;" ${busy}>
        ${icon('sparkle', 16)} ${state.billFormBusy ? 'Reading…' : 'Fill in with AI'}
      </button>
    </div>

    <form id="bill-form" class="form" style="margin-top:12px;">
      <label class="field">
        <span class="field-label">Provider</span>
        <input class="input" name="providerName" placeholder="e.g. Netflix"
          value="${escapeHtml(d.providerName)}" required ${busy} />
      </label>
      <label class="field">
        <span class="field-label">Amount due</span>
        <input class="input" name="amountDue" type="number" step="0.01" min="0"
          placeholder="0.00" value="${d.amountDue}" required ${busy} />
      </label>
      <label class="field">
        <span class="field-label">Due date</span>
        <input class="input" name="dueDate" type="date" value="${d.dueDate}" required ${busy} />
      </label>
      <label class="field">
        <span class="field-label">Category</span>
        <select class="select" name="category" ${busy}>
          <option value="">Choose one…</option>
          ${BILL_CATEGORIES.map(([, name]) => `
            <option value="${name}" ${d.category === name ? 'selected' : ''}>${name}</option>
          `).join('')}
        </select>
      </label>
      <div class="btn-row">
        <button type="submit" class="btn btn-primary" ${busy}>
          ${state.billFormBusy ? 'Saving…' : 'Save bill'}
        </button>
        <button type="button" class="btn btn-outline" data-action="toggle-bill-form" ${busy}>Cancel</button>
      </div>
    </form>
  `, { sub: 'For anything the bank feed and your email both miss' });
}

/**
 * Paystub entry and the reconciliation it produces against the forecast for
 * that same pay period — the loop that lets the app learn an actual effective
 * tax rate instead of the one guessed once during pay setup.
 */
function renderPaystubs() {
  if (!state.session) return `${segmented(INCOME_TABS)}${signInPrompt('reconcile paystubs')}`;

  if (!state.payProfile) {
    return `
      ${segmented(INCOME_TABS)}
      ${emptyState({
        iconName: 'calendar',
        title: 'Set up pay first',
        body: 'Reconciliation compares a real stub against a forecast, and the forecast needs a pay profile.',
        action: '<button class="btn btn-primary" data-view="shifts">Go to pay setup</button>',
      })}`;
  }

  if (state.paystubsError) {
    return `${segmented(INCOME_TABS)}<div class="banner banner-warn"><div class="banner-body">${state.paystubsError}</div></div>`;
  }

  const learned = state.learnedAdjustments;

  return `
    ${segmented(INCOME_TABS)}

    ${learned ? section('What the stubs say', `
      <div class="card">
        <div class="prose">${learned.ready ? learned.summary : learned.reason}</div>
        ${learned.ready && (learned.suggestedTaxRate != null || learned.suggestedDeductions?.length) ? `
          ${state.adjustmentsNotice ? `<div class="banner banner-good" style="margin:10px 0 0;"><div class="banner-body">${state.adjustmentsNotice}</div></div>` : ''}
          <button data-action="apply-adjustments" class="btn btn-secondary btn-block" style="margin-top:10px;">
            Apply these adjustments to pay setup
          </button>
        ` : ''}
      </div>
    `) : ''}

    ${section('Enter a paystub', `
      <form id="paystub-form" class="form">
        ${field('Pay date', 'payDate', 'date', '', 'required')}
        ${field('Period start', 'periodStart', 'date', '', 'required')}
        ${field('Period end', 'periodEnd', 'date', '', 'required')}
        ${field('Gross pay', 'grossPay', 'number', '', 'step="0.01" min="0" required')}
        ${field('Net pay', 'netPay', 'number', '', 'step="0.01" min="0" required')}
        ${field('Total taxes withheld', 'totalTaxes', 'number', '', 'step="0.01" min="0" required')}
        <details class="fold">
          <summary>Hours and other deductions</summary>
          <div class="fold-body form">
            ${field('Regular hours', 'regularHours', 'number', '', 'step="0.01" min="0"')}
            ${field('Overtime hours', 'overtimeHours', 'number', '', 'step="0.01" min="0"')}
            <label class="field">
              <span class="field-label">Other deductions — one per line, "Label: Amount"</span>
              <textarea class="textarea" name="deductions" rows="3"
                placeholder="401k: 128.00&#10;Health insurance: 84.50"></textarea>
            </label>
          </div>
        </details>
        ${state.paystubFormError ? `<div class="banner banner-warn" style="margin:0;"><div class="banner-body">${state.paystubFormError}</div></div>` : ''}
        <button type="submit" class="btn btn-primary btn-block" ${state.paystubBusy ? 'disabled' : ''}>
          ${state.paystubBusy ? 'Saving…' : 'Save and reconcile'}
        </button>
      </form>
    `, {
      sub: 'Three or more stubs is enough to start correcting the tax assumptions',
    })}

    ${section('History', state.reconciliations.length === 0
      ? emptyState({ iconName: 'inbox', title: 'No paystubs entered yet' })
      : `
        <div class="list">
          ${state.reconciliations.map((r) => row({
            iconName: 'calendar',
            title: new Date(`${r.payDate}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
            chips: r.materialVariance ? '<span class="chip chip-warn">off forecast</span>' : '<span class="chip chip-ok">matched</span>',
            sub: `Forecast ${moneyExact(r.net.expected)} · ${r.net.difference >= 0 ? '+' : ''}${moneyExact(r.net.difference)}${r.net.percentDifference != null ? ` (${r.net.percentDifference}%)` : ''}`
              + (r.findings.length ? `<br>${r.findings.join(' · ')}` : ''),
            amount: moneyExact(r.net.actual),
            amountSub: 'net',
          })).join('')}
        </div>`)}
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
      <div style="margin-top:8px;">
        <button class="linkbtn quiet" data-action="dismiss-install">Dismiss</button>
      </div>
    </div>`;
}

/**
 * Title and one line of context for the current screen.
 *
 * Every view used to open with its own `<h2>`, styled slightly differently
 * and placed slightly differently, so the top of the app moved around as you
 * navigated. One bar, one place, one shape.
 */
const VIEW_HEADERS = {
  dashboard: () => ['Home', state.session ? 'Your household, right now' : 'Demo numbers — nothing here is real yet'],
  budget: () => ['Budget', 'Bills and necessities, and what\'s left of them'],
  bills: () => ['Budget', 'What you owe, and when it has to be covered'],
  spending: () => ['Spending', 'Where the money actually goes'],
  transactions: () => ['Spending', 'Every transaction, newest first'],
  year: () => ['Spending', 'Twelve months at a time'],
  subscriptions: () => ['Recurring', 'What renews, and what it costs per year'],
  trends: () => ['Trends', 'How each category moves month to month'],
  review: () => ['Spending', 'Transactions the categorizer wasn\'t sure about'],
  income: () => ['Income', 'What lands, and when'],
  paycheck: () => ['Income', 'How to split the next check'],
  shifts: () => ['Income', 'Hours logged, and what they forecast'],
  paystubs: () => ['Income', 'Real stubs against the forecast'],
  plan: () => ['Plan', 'The order to do things in'],
  advisor: () => ['Advisor', 'A read on your own numbers'],
  connect: () => ['Accounts', 'Banks, email, and who else is here'],
  more: () => ['Settings', ''],
};

function renderAppBar() {
  const [title, sub] = (VIEW_HEADERS[state.view] ?? (() => ['Family Budget', '']))();
  const showBack = state.view === 'review' || state.view === 'plan';
  const backTo = state.view === 'review' ? 'transactions' : 'more';

  return `
    <header class="app-bar">
      <div class="app-bar-text">
        <div class="app-bar-title">${title}</div>
        ${sub ? `<div class="app-bar-sub">${sub}</div>` : ''}
      </div>
      ${showBack
        ? `<button class="icon-btn" data-view="${backTo}" aria-label="Back">${icon('back', 17)}</button>`
        : `<button class="icon-btn" data-view="more" aria-label="Settings">${icon('settings', 17)}</button>`}
    </header>
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

  // Recategorizing moves spending between buckets, which moves the baseline,
  // which moves what a paycheck can spare. Everything downstream is stale until
  // this runs.
  buildPlan();
  render();
}

function render() {
  const app = document.getElementById('app');

  if (state.bootLoading) {
  app.innerHTML = `
    ${renderAppBar()}
    <main>
      <div class="loading">
        Updating your numbers…
        <div class="prose-sm" style="margin-top:8px;">You can move around while the bank connection finishes.</div>
      </div>
    </main>
    ${renderBottomNav()}
  `;
  app.querySelectorAll('[data-view]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      if (state.view !== 'transactions') state.transactionFilter = null;
      render();
    }),
  );
  return;
}

  const body = {
    dashboard: renderDashboard,
    paycheck: renderPaycheck,
    plan: renderPlan,
    budget: renderBudget,
    spending: renderSpending,
    year: renderYear,
    subscriptions: renderSubscriptions,
    transactions: renderTransactions,
    review: renderReview,
    trends: renderTrends,
    income: renderIncome,
    shifts: renderShifts,
    paystubs: renderPaystubs,
    bills: renderBills,
    advisor: renderAdvisor,
    connect: renderConnect,
    more: renderMore,
  }[state.view]();

  app.innerHTML = `
    ${renderAppBar()}
    ${renderSyncBanner()}
    <main>${body}</main>
    ${renderInstallHint()}
    ${renderBottomNav()}
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
      if (state.view !== 'transactions') state.transactionFilter = null;
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
      if ((state.view === 'bills' || state.view === 'budget') && !state.billsAttempted) {
        state.billsAttempted = true;
        const haveSession = state.connectAttempted;
        state.connectAttempted = true;
        (haveSession ? Promise.resolve() : refreshConnection())
          .then(refreshBills)
          .then(render);
      }
      // Paystubs needs both a session and the pay profile Shifts sets up, so
      // it establishes both rather than showing an empty state a reload would fix.
      if (state.view === 'paystubs' && !state.paystubsAttempted) {
        state.paystubsAttempted = true;
        const haveSession = state.connectAttempted;
        state.connectAttempted = true;
        const haveProfile = state.shiftsAttempted;
        state.shiftsAttempted = true;
        (haveSession ? Promise.resolve() : refreshConnection())
          .then(() => (haveProfile ? Promise.resolve() : refreshShifts()))
          .then(refreshPaystubs)
          .then(render);
      }
      // Advisor needs a session to read/write its note history, same pattern
      // as the other tabs above — does not generate a note on visit, only
      // loads past ones, since generating one is a real API call the user
      // should trigger deliberately, not something that fires on every tab click.
      // The browser is the authority on notification permission, and it can
      // change outside the app, so this is re-read on every visit to More
      // rather than cached.
      if (state.view === 'more' && state.session) {
        loadConnect()
          .then((connect) => connect.pushStatus())
          .then((status) => {
            state.push = status;
            render();
          })
          .catch(() => { /* the row falls back to "cannot show them" */ });
      }

      if (state.view === 'advisor' && !state.advisorAttempted) {
        state.advisorAttempted = true;
        const haveSession = state.connectAttempted;
        state.connectAttempted = true;
        (haveSession ? Promise.resolve() : refreshConnection())
          .then(refreshAdvisorNotes)
          .then(render);
      }
      render(); // shows the view immediately either way
    }),
  );

  // "Where it went" rows are <details>. Remember which are open so the next
  // render — triggered by categorizing something inside one, for instance —
  // leaves them open.
  // --- Splitting a charge ------------------------------------------------
  app.querySelectorAll('[data-split]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const id = btn.dataset.split;
      state.splitting = state.splitting === id ? null : id;
      state.splitDraft = [];
      state.splitError = null;
      render();
    }),
  );

  // Reading the draft out of the DOM before every re-render is what lets the
  // remainder update as it is typed without losing what is already entered.
  const readSplitDraft = (form) => [...form.querySelectorAll('.split-row')].map((row) => ({
    amount: row.querySelector('[name="amount"]').value,
    category: row.querySelector('[name="category"]').value,
  }));

  app.querySelectorAll('[data-split-form]').forEach((form) => {
    form.addEventListener('input', () => {
      state.splitDraft = readSplitDraft(form);
      state.splitError = null;
      // Re-render only the remainder line, so focus and the caret stay put.
      const foot = form.querySelector('.split-foot span');
      if (!foot) return;
      const next = splitFootState(state.splitDraft, Math.abs(Number(form.dataset.total ?? 0)));
      foot.className = next.ok ? 'ok' : 'off';
      foot.textContent = next.label;
    });

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const txn = state.transactions.find(
        (t) => (t.plaid_transaction_id ?? t.id) === form.dataset.splitForm,
      );
      if (!txn) return;

      const plan = planSplit(txn, readSplitDraft(form));
      if (!plan.ok) {
        state.splitDraft = readSplitDraft(form);
        state.splitError = plan.error;
        render();
        return;
      }

      state.splitBusy = true;
      state.splitError = null;
      render();
      try {
        const connect = await loadConnect();
        // Replacing an existing split rather than stacking a second one.
        if (splitChildrenOf(txn).length) await connect.unsplit(txn.id);
        await connect.saveSplit(plan.children);
        state.transactions = await connect.listTransactions();
        buildPlan();
        state.splitting = null;
        state.splitDraft = [];
      } catch (e) {
        state.splitError = `Couldn't save that split: ${e.message}`;
      } finally {
        state.splitBusy = false;
        render();
      }
    });
  });

  app.querySelectorAll('[data-split-add]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const form = btn.closest('[data-split-form]');
      state.splitDraft = [...readSplitDraft(form), { amount: '', category: '' }];
      render();
    }),
  );

  app.querySelectorAll('[data-split-remove]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const form = btn.closest('[data-split-form]');
      const draft = readSplitDraft(form);
      draft.splice(Number(btn.dataset.splitRemove), 1);
      state.splitDraft = draft;
      render();
    }),
  );

  app.querySelectorAll('[data-split-cancel]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.splitting = null;
      state.splitDraft = [];
      state.splitError = null;
      render();
    }),
  );

  app.querySelectorAll('[data-unsplit]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      state.splitBusy = true;
      render();
      try {
        const connect = await loadConnect();
        await connect.unsplit(btn.dataset.unsplit);
        state.transactions = await connect.listTransactions();
        buildPlan();
        state.splitting = null;
        state.splitDraft = [];
      } catch (e) {
        state.splitError = `Couldn't undo that split: ${e.message}`;
      } finally {
        state.splitBusy = false;
        render();
      }
    }),
  );

  const pushToggle = app.querySelector('[data-action="toggle-push"]');
  if (pushToggle) {
    pushToggle.addEventListener('click', async () => {
      state.pushBusy = true;
      state.pushError = null;
      render();
      try {
        const connect = await loadConnect();
        if (state.push.enabled) await connect.disablePushNotifications();
        else await connect.enablePushNotifications(state.householdId);
        state.push = await connect.pushStatus();
      } catch (e) {
        state.pushError = e.message;
        // Re-read rather than assume: a denied permission changes what the
        // row should say, not just whether this attempt worked.
        try {
          state.push = await (await loadConnect()).pushStatus();
        } catch { /* leave the last known state */ }
      }
      state.pushBusy = false;
      render();
    });
  }

  const dismissHousehold = app.querySelector('[data-action="dismiss-household-prompt"]');
  if (dismissHousehold) {
    dismissHousehold.addEventListener('click', () => {
      try {
        localStorage.setItem('householdPromptDismissed', '1');
      } catch {
        /* Blocked storage just means it asks again next launch. */
      }
      render();
    });
  }

  const trackAll = app.querySelector('[data-action="track-all-bills"]');
  if (trackAll) {
    trackAll.addEventListener('click', async () => {
      const recurring = [...(state.subs?.bills ?? []), ...(state.subs?.subscriptions ?? [])];
      const pending = suggestBillsFromTransactions({
        streams: recurring,
        bills: [...state.bills, ...state.billsNeedingReview],
      }).filter((x) => !state.dismissedSuggestions.has(x.key) && !x.stale);

      state.trackingBill = '*';
      state.billsError = null;
      render();
      try {
        const bills = await loadBills();
        // Sequentially, not in parallel: each createBill dedupes against the
        // bills that already exist, and a parallel burst would race that check
        // and write the same provider twice.
        for (const suggestion of pending) {
          await bills.createBill({
            providerName: suggestion.providerName,
            amountDue: suggestion.amountDue,
            dueDate: suggestion.dueDate,
            category: suggestion.category,
            source: 'bank',
          });
        }
        await refreshBills();
      } catch (e) {
        state.billsError = e.message;
      }
      state.trackingBill = null;
      render();
    });
  }

  const logoToggle = app.querySelector('[data-action="toggle-logos"]');
  if (logoToggle) {
    logoToggle.addEventListener('click', () => {
      state.showLogos = !state.showLogos;
      try {
        localStorage.setItem('showLogos', state.showLogos ? '1' : '0');
      } catch {
        /* A blocked localStorage must not stop the toggle working this session. */
      }
      render();
    });
  }

  const autoCat = app.querySelector('[data-action="auto-categorize"]');
  if (autoCat) {
    autoCat.addEventListener('click', async () => {
      state.autoCategorizing = true;
      state.autoCategorizeResult = null;
      state.autoCategorizeError = null;
      render();
      try {
        const connect = await loadConnect();
        const { categorized, skipped } = await connect.categorizeUnknowns();
        state.autoCategorizeResult = categorized
          ? `${categorized} sorted${skipped ? `, ${skipped} still unclear` : ''}.`
          : 'Nothing could be named with confidence — these need you.';
        // Re-read rather than patching in place: the write happened server-side,
        // and re-reading is the only way to be sure the screen matches it.
        state.transactions = await connect.listTransactions();
        buildPlan();
      } catch (e) {
        state.autoCategorizeError = `Couldn't look those up: ${e.message}`;
      } finally {
        state.autoCategorizing = false;
        render();
      }
    });
  }

  const clearFilter = app.querySelector('[data-action="clear-txn-filter"]');
  if (clearFilter) {
    clearFilter.addEventListener('click', () => {
      state.transactionFilter = null;
      render();
    });
  }

  app.querySelectorAll('details.cat-row').forEach((node) =>
    node.addEventListener('toggle', () => {
      if (node.open) state.openCategories.add(node.dataset.category);
      else state.openCategories.delete(node.dataset.category);
    }),
  );

  // Anything else that names a category and isn't an action jumps to the full
  // transaction list, filtered to it.
  app.querySelectorAll('button[data-category]:not([data-action])').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.transactionFilter = btn.dataset.category;
      state.view = 'transactions';
      render();
    }),
  );

  app.querySelectorAll('[data-action="edit-target"]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const cat = btn.dataset.category;
      state.editingTarget = state.editingTarget === cat ? null : cat;
      render();
    }),
  );

  app.querySelectorAll('[data-action="clear-target"]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      state.editingTarget = null;
      const done = setBudgetTarget(btn.dataset.category, null);
      render();
      await done;
      render(); // shows the failure if the write didn't land
    }),
  );

  app.querySelectorAll('[data-target-form]').forEach((form) =>
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const amount = Number(form.amount.value);
      state.editingTarget = null;
      // An empty or nonsense entry clears the override rather than storing a
      // NaN target that would make every derived figure on the tab garbage.
      const done = setBudgetTarget(
        form.dataset.targetForm,
        Number.isFinite(amount) && amount > 0 ? amount : null,
      );
      render();
      await done;
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

  app.querySelectorAll('[data-edit-category]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const id = btn.dataset.editCategory;
      state.editingCategory = state.editingCategory === id ? null : id;
      render();
      // Open the picker straight away — the tap was the intent to change it,
      // not a request to be shown a control to tap again.
      document.querySelector(`.cat-select[data-id="${id}"]`)?.focus();
    }),
  );

  app.querySelectorAll('.cat-select').forEach((sel) =>
    sel.addEventListener('change', () => {
      state.editingCategory = null;
      recategorize(sel.dataset.id, sel.value);
    }),
  );

  const search = document.getElementById('search');
  if (search) {
    search.addEventListener('input', () => {
      const q = search.value.toLowerCase();
      document.querySelectorAll('#txn-list .row').forEach((node) => {
        node.style.display = node.dataset.search.includes(q) ? '' : 'none';
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
        // Bills and the household's budget targets, so signing in lands on a
        // populated Budget tab rather than one that looks empty until reload.
        state.billsAttempted = true;
        await refreshBills();
        autoCategorizeUnknowns(); // not awaited: signing in must not wait on it
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

  app.querySelectorAll('[data-action="disconnect-gmail"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      state.gmailBusy = true;
      render();
      try {
        const connect = await loadConnect();
        await connect.disconnectGmail(id);
        await refreshConnection();
        state.gmailNotice = 'Gmail disconnected.';
      } catch (e) {
        state.gmailError = e.message;
      }
      state.gmailBusy = false;
      render();
    });
  });

  const advisorBtn = app.querySelector('[data-action="get-advisor-note"]');
  if (advisorBtn) {
    advisorBtn.addEventListener('click', async () => {
      state.advisorBusy = true;
      state.advisorError = null;
      render();
      try {
        const connect = await loadConnect();
        const note = await connect.getAdvisorNote(buildAdvisorSummary());
        state.advisorNotes = [note, ...state.advisorNotes];
      } catch (e) {
        state.advisorError = e.message;
      }
      state.advisorBusy = false;
      render();
    });
  }

  const advisorAskForm = document.getElementById('advisor-ask-form');
  if (advisorAskForm) {
    advisorAskForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const question = advisorAskForm.question.value.trim();
      if (!question) return;

      state.advisorBusy = true;
      state.advisorError = null;
      render();
      try {
        const connect = await loadConnect();
        const note = await connect.getAdvisorNote(buildAdvisorSummary(), question);
        state.advisorNotes = [note, ...state.advisorNotes];
      } catch (e) {
        state.advisorError = e.message;
      }
      state.advisorBusy = false;
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

  const paystubForm = document.getElementById('paystub-form');
  if (paystubForm) {
    paystubForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = paystubForm;

      const deductions = f.deductions.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const i = line.lastIndexOf(':');
          if (i < 0) return null;
          const amount = Number(line.slice(i + 1).replace(/[$,]/g, '').trim());
          return Number.isFinite(amount) ? { label: line.slice(0, i).trim(), amount } : null;
        })
        .filter(Boolean);

      const stub = makePaystub({
        payDate: f.payDate.value,
        period: { start: f.periodStart.value, end: f.periodEnd.value },
        grossPay: Number(f.grossPay.value),
        netPay: Number(f.netPay.value),
        totalTaxes: Number(f.totalTaxes.value),
        regularHours: f.regularHours.value ? Number(f.regularHours.value) : undefined,
        overtimeHours: f.overtimeHours.value ? Number(f.overtimeHours.value) : undefined,
        deductions,
        source: 'manual',
      });

      const { valid, errors } = validatePaystub(stub);
      if (!valid) {
        state.paystubFormError = errors.join('; ');
        render();
        return;
      }

      state.paystubBusy = true;
      state.paystubFormError = null;
      state.adjustmentsNotice = null;
      render();
      try {
        const [paystubs, shifts] = await Promise.all([loadPaystubs(), loadShifts()]);
        const saved = await paystubs.savePaystub(stub, state.householdId);

        // Reconcile against the forecast for THIS stub's own period, not
        // whatever "upcoming" currently means — a stub entered for a past
        // period must be compared to what was forecast for that period.
        const entries = await shifts.listTimeEntries(saved.period.start, saved.period.end);
        const forecast = forecastPaycheck({
          profile: state.payProfile, entries, period: saved.period, payDate: saved.payDate,
        });
        const reconciliation = reconcilePaycheck(forecast, saved);
        await paystubs.saveReconciliation(reconciliation, state.householdId, null);

        f.reset();
        await refreshPaystubs();
      } catch (e) {
        state.paystubFormError = e.message;
      }
      state.paystubBusy = false;
      render();
    });
  }

  const applyAdjustmentsBtn = app.querySelector('[data-action="apply-adjustments"]');
  if (applyAdjustmentsBtn) {
    applyAdjustmentsBtn.addEventListener('click', async () => {
      const { profile: adjusted, changed, changes } = applyLearnedAdjustments(state.payProfile, state.learnedAdjustments);
      if (!changed) return;
      try {
        const shifts = await loadShifts();
        state.payProfile = await shifts.savePayProfile(adjusted, state.householdId, state.payProfile.id);
        state.adjustmentsNotice = `Applied: ${changes.join('; ')}.`;
        await refreshPaystubs();
      } catch (e) {
        state.paystubsError = e.message;
      }
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

  app.querySelectorAll('[data-action="dismiss-alert"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      dismissAlert(btn.dataset.key);
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

  app.querySelectorAll('[data-action="toggle-bill-form"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.billFormOpen = !state.billFormOpen;
      state.billFormError = null;
      if (state.billFormOpen) {
        state.billParseText = '';
        state.billDraft = { providerName: '', amountDue: '', dueDate: '', category: '' };
      }
      render();
    });
  });

  /**
   * Accept a recurring charge as a bill.
   *
   * Saved as source 'bank' with full confidence: the household has just
   * confirmed something the bank feed already proved they pay, which is
   * stronger evidence than any parse. createBill still runs it through the
   * same duplicate check as every other route, so accepting one the household
   * also has in email updates that row rather than adding a second.
   */
  app.querySelectorAll('[data-action="track-bill"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.key;
      const recurring = [...(state.subs?.bills ?? []), ...(state.subs?.subscriptions ?? [])];
      const suggestion = suggestBillsFromTransactions({
        streams: recurring,
        bills: [...state.bills, ...state.billsNeedingReview],
      }).find((s) => s.key === key);
      if (!suggestion) return;

      state.trackingBill = key;
      state.billsError = null;
      render();
      try {
        const bills = await loadBills();
        await bills.createBill({
          providerName: suggestion.providerName,
          amountDue: suggestion.amountDue,
          dueDate: suggestion.dueDate,
          category: suggestion.category,
          source: 'bank',
        });
        await refreshBills();
      } catch (e) {
        state.billsError = e.message;
      }
      state.trackingBill = null;
      render();
    });
  });

  app.querySelectorAll('[data-action="dismiss-suggestion"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      dismissSuggestion(btn.dataset.key);
      render();
    });
  });

  const parseBillBtn = app.querySelector('[data-action="parse-bill-text"]');
  if (parseBillBtn) {
    parseBillBtn.addEventListener('click', async () => {
      const text = document.getElementById('bill-parse-text')?.value.trim() ?? '';
      state.billParseText = text;
      if (!text) {
        state.billFormError = 'Paste some bill text first.';
        render();
        return;
      }

      state.billFormBusy = true;
      state.billFormError = null;
      render();
      try {
        const bills = await loadBills();
        const extracted = await bills.parseBillText(text);
        state.billDraft = {
          providerName: extracted.providerName ?? state.billDraft.providerName,
          amountDue: extracted.amountDue != null ? String(extracted.amountDue) : state.billDraft.amountDue,
          dueDate: extracted.dueDate ?? state.billDraft.dueDate,
          category: BILL_CATEGORIES.some(([, name]) => name === extracted.category)
            ? extracted.category
            : state.billDraft.category,
        };
        if (extracted.confidence < 0.6) {
          state.billFormError = 'Low confidence — double-check every field before saving.';
        }
      } catch (e) {
        state.billFormError = e.message;
      }
      state.billFormBusy = false;
      render();
    });
  }

  const billForm = document.getElementById('bill-form');
  if (billForm) {
    billForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const providerName = billForm.providerName.value.trim();
      const amountDue = Number(billForm.amountDue.value);
      const dueDate = billForm.dueDate.value;
      const category = billForm.category.value;
      if (!providerName || !Number.isFinite(amountDue) || amountDue < 0 || !dueDate) {
        state.billFormError = 'Provider, amount, and due date are required.';
        render();
        return;
      }

      state.billFormBusy = true;
      state.billFormError = null;
      render();
      try {
        const bills = await loadBills();
        await bills.createBill({ providerName, amountDue, dueDate, category });
        state.billFormOpen = false;
        state.billParseText = '';
        state.billDraft = { providerName: '', amountDue: '', dueDate: '', category: '' };
        await refreshBills();
      } catch (e) {
        state.billFormError = e.message;
      }
      state.billFormBusy = false;
      render();
    });
  }

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

/**
 * Whether this browser has signed in before, checked with zero network calls
 * so it can gate the very first render.
 *
 * Supabase persists its session to localStorage under a key shaped like
 * `sb-<project-ref>-auth-token`. A match here doesn't guarantee the session
 * is still valid — only that this browser very likely has real data coming,
 * which is enough to decide whether the first paint should be the demo
 * dashboard or a plain loading state. refreshConnection() below is still
 * what actually validates the session.
 */
function hasPersistedSession() {
  try {
    return Object.keys(localStorage).some((k) => /^sb-.*-auth-token$/.test(k));
  } catch {
    return false;
  }
}

consumeGmailOAuthReturn();

// A browser with no persisted session has no real data coming — paint the
// demo dashboard immediately, the whole reason fixtures work with zero
// network dependency. A browser that has signed in before almost certainly
// does, and flashing synthetic numbers at someone with a real budget for a
// few seconds reads as the app being wrong, not as it loading — so that case
// waits behind a plain loading state instead (see the IIFE below).
if (hasPersistedSession()) state.bootLoading = true;

load().then(render).catch((e) => {
  document.getElementById('app').innerHTML =
    `<div class="banner banner-warn">Could not load data: ${e.message}</div>`;
});

// A returning signed-in user's session, bills, and alerts load in the
// background, after the demo dashboard has already painted (or, for a
// likely-returning user, behind the loading state bootLoading gates render()
// on) — never blocking that first attempt is the whole reason fixtures work
// with zero network dependency. Runs unconditionally (not just after a
// Gmail OAuth return) so alerts and bills are current the moment the app
// opens, without requiring a manual visit to Connect or Bills first.
(async () => {
  state.connectAttempted = true;

  // A likely-returning user waits behind the loading state, but not forever —
  // an offline PWA (the whole reason this works with zero network dependency)
  // must not hang on "Loading your numbers…" if the network never answers.
  // Falls back to the demo dashboard exactly like a never-signed-in browser
  // would, and still swaps to real data via the render() below whenever
  // refreshConnection actually does resolve, even long after this fires.
  const bootTimeout = setTimeout(() => {
    if (state.bootLoading) {
      state.bootLoading = false;
      render();
    }
  }, 6000);

  await refreshConnection();
    clearTimeout(bootTimeout);
    state.bootLoading = false;
    render();

    // Bills and category targets are useful, but they are not required to
    // make Home/Spending/Settings interactive. Hydrate them after first paint.
    state.billsAttempted = true;
    refreshBills().then(render).catch(() => render());

  // Not awaited: naming the leftovers is a server round-trip through a model,
  // and the app must never sit on a loading screen waiting for it. It runs
  // behind the rendered dashboard and re-renders if it changed anything.
  autoCategorizeUnknowns();
})();
