import { analyzeSubscriptions } from '../src/engine/subscriptions.js';
import { buildReliableSubscriptionStreams } from '../src/engine/reliable-subscriptions.js';
import { detectIncomeStreams } from '../src/engine/income.js';
import { buildUpcomingObligations, obligationProvidersMatch } from '../src/engine/bill-center.js';
import { buildMoneyPlanSummary } from '../src/engine/money-plan-summary.js';

let dataPromise = null;
let running = false;
let scheduled = false;

const money = (n) => Number(n || 0).toLocaleString('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const money0 = (n) => Number(n || 0).toLocaleString('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});

function localIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateLabel(date) {
  if (!date) return '';
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function planActive() {
  return Boolean(document.querySelector('main .seg-btn[data-view="bills"].active'));
}

function ensureStyle() {
  if (document.getElementById('money-plan-ui-style')) return;
  const style = document.createElement('style');
  style.id = 'money-plan-ui-style';
  style.textContent = `
    [data-money-plan-summary]{margin:2px 0 15px}
    [data-money-plan-summary] .mp-card{background:var(--surface);border:1px solid var(--border);border-radius:18px;overflow:hidden;box-shadow:var(--shadow-sm)}
    [data-money-plan-summary] .mp-head{padding:15px 15px 13px}
    [data-money-plan-summary] .mp-eyebrow{font-size:10.5px;font-weight:820;letter-spacing:.055em;text-transform:uppercase;color:var(--muted)}
    [data-money-plan-summary] .mp-title{display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin-top:2px}
    [data-money-plan-summary] .mp-title strong{font-size:21px;letter-spacing:-.03em}
    [data-money-plan-summary] .mp-title span{font-size:15px;font-weight:820;color:var(--positive);white-space:nowrap}
    [data-money-plan-summary] .mp-sub{font-size:10.5px;color:var(--muted);margin-top:3px}
    [data-money-plan-summary] .mp-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 12px;padding:11px 15px;border-top:1px solid var(--border)}
    [data-money-plan-summary] .mp-row-label{font-size:12px;font-weight:760}
    [data-money-plan-summary] .mp-row-value{font-size:12.5px;font-weight:840;font-variant-numeric:tabular-nums}
    [data-money-plan-summary] .mp-row-sub{grid-column:1/-1;font-size:10px;color:var(--muted);line-height:1.35}
    [data-money-plan-summary] .mp-row.total{background:var(--surface-2)}
    [data-money-plan-summary] .mp-row.total .mp-row-label,[data-money-plan-summary] .mp-row.total .mp-row-value{font-size:13.5px}
    [data-money-plan-summary] .mp-row-value.negative{color:var(--negative)}
    [data-money-plan-summary] .mp-warning{margin-top:9px;border-radius:13px;padding:10px 11px;background:var(--warn-soft);font-size:11px;line-height:1.45;color:var(--text)}
    [data-money-plan-summary] .mp-warning b{font-weight:850}
    [data-money-plan-summary] .mp-note{font-size:10px;color:var(--muted);line-height:1.4;margin:8px 3px 0}
  `;
  document.head.appendChild(style);
}

function dedupeUpcoming(items) {
  const out = [];
  for (const item of items) {
    const existing = out.find((row) => obligationProvidersMatch(row.providerName, item.providerName));
    if (!existing) {
      out.push(item);
      continue;
    }
    // A tracked bill has a household-confirmed due date and wins over a bank projection.
    const existingTracked = Boolean(existing.id && !String(existing.id).startsWith('recurring:'));
    const incomingTracked = Boolean(item.id && !String(item.id).startsWith('recurring:'));
    if (!existingTracked && incomingTracked) out[out.indexOf(existing)] = item;
    else if (existingTracked === incomingTracked && item.dueDate < existing.dueDate) out[out.indexOf(existing)] = item;
  }
  return out;
}

async function loadData(force = false) {
  if (force) dataPromise = null;
  if (!dataPromise) {
    dataPromise = Promise.all([
      import('./connect.js'), import('./bills.js'), import('./budget-targets.js'),
    ]).then(async ([connect, bills, budgetTargets]) => {
      const session = await connect.getSession();
      if (!session) return null;
      const [transactions, rawBills, suppressions, targets] = await Promise.all([
        connect.listTransactions(), bills.listBillsForCenter(), bills.listBillSuppressions(), budgetTargets.listBudgetTargets(),
      ]);
      const analysis = analyzeSubscriptions(transactions);
      const recurring = [
        ...(analysis.bills ?? []),
        ...buildReliableSubscriptionStreams(transactions, { asOf: localIso() }),
      ].filter((stream) => !suppressions.some((marker) => obligationProvidersMatch(marker.providerName, stream.payee)));
      const tracked = rawBills.filter((bill) => !suppressions.some((marker) => obligationProvidersMatch(marker.providerName, bill.providerName)));
      const upcoming = dedupeUpcoming(buildUpcomingObligations({
        bills: tracked, recurring, transactions, asOf: localIso(),
      }));
      const incomeStreams = detectIncomeStreams(transactions);
      return { transactions, targets, upcoming, incomeStreams };
    });
  }
  return dataPromise;
}

function render(host, data) {
  const summary = buildMoneyPlanSummary({
    transactions: data.transactions,
    upcomingBills: data.upcoming,
    incomeStreams: data.incomeStreams,
    budgetTargets: data.targets,
    asOf: localIso(),
  });

  if (!summary.nextPayday) {
    host.innerHTML = '<div class="mp-warning"><b>No reliable payday pattern yet.</b> Once the bank has enough real payroll deposits, this card will connect each check to the bills it needs to cover.</div>';
    return;
  }

  const essentialsRange = summary.essentials.expected
    ? `${money0(summary.essentials.low)}–${money0(summary.essentials.high)}`
    : 'Not enough history';
  const uncommittedLabel = summary.uncommitted >= 0
    ? money(summary.uncommitted)
    : `−${money(Math.abs(summary.uncommitted))}`;

  const warnings = [];
  if (summary.dueBeforeNextPayday.total > 0) {
    warnings.push(`<div class="mp-warning"><b>${money(summary.dueBeforeNextPayday.total)} is due before ${dateLabel(summary.nextPayday)}.</b> That money needs to already be in the account; the next check arrives too late for it.</div>`);
  }
  if (summary.heavyCluster) {
    const c = summary.heavyCluster;
    warnings.push(`<div class="mp-warning"><b>Heavy bill stretch ${dateLabel(c.start)}–${dateLabel(c.end)}.</b> ${money(c.total)} across ${c.count} bills lands within one week. Keep that part of the ${dateLabel(summary.nextPayday)} check parked for those bills.</div>`);
  }
  if (summary.uncommitted < 0) {
    warnings.push(`<div class="mp-warning"><b>The next check alone is about ${money(Math.abs(summary.uncommitted))} short.</b> That is after its assigned bills plus the normal groceries/gas allowance. Keep some current balance reserved or adjust the flexible budget before that stretch.</div>`);
  }

  host.innerHTML = `
    <div class="mp-card">
      <div class="mp-head">
        <div class="mp-eyebrow">Next paycheck plan</div>
        <div class="mp-title"><strong>${dateLabel(summary.nextPayday)}</strong><span>~${money(summary.paycheckEstimate)}</span></div>
        <div class="mp-sub">Typical deposited check · planning through ${dateLabel(summary.followingPayday)}</div>
      </div>
      <div class="mp-row">
        <div class="mp-row-label">Bills & subscriptions</div><div class="mp-row-value">${money(summary.bills.total)}</div>
        <div class="mp-row-sub">${summary.bills.items.length} obligation${summary.bills.items.length === 1 ? '' : 's'} assigned to this paycheck by due date.</div>
      </div>
      <div class="mp-row">
        <div class="mp-row-label">Groceries & gas</div><div class="mp-row-value">~${money(summary.essentials.expected)}</div>
        <div class="mp-row-sub">Typical range ${essentialsRange} for the ${summary.essentials.days}-day pay period. Shared Budget targets override the automatic estimate.</div>
      </div>
      <div class="mp-row total">
        <div class="mp-row-label">Uncommitted from this check</div><div class="mp-row-value ${summary.uncommitted < 0 ? 'negative' : ''}">${uncommittedLabel}</div>
        <div class="mp-row-sub">What is left after the obligations above. It is not a recommendation to spend it.</div>
      </div>
    </div>
    ${warnings.join('')}
    <div class="mp-note">This plan comes from the same bank transactions, bill due dates and shared category budgets used everywhere else in the app.</div>
  `;
}

function mount(data) {
  const center = document.querySelector('[data-bill-center]');
  if (!center || !planActive()) return;
  let host = center.querySelector('[data-money-plan-summary]');
  if (!host) {
    host = document.createElement('div');
    host.dataset.moneyPlanSummary = '1';
    const calendar = center.querySelector('.bill-calendar');
    if (calendar) center.insertBefore(host, calendar);
    else center.prepend(host);
  }
  render(host, data);
}

async function run() {
  if (running || !planActive()) return;
  running = true;
  try {
    ensureStyle();
    const data = await loadData(true);
    if (data && planActive()) mount(data);
  } catch {
    // The Plan calendar/list remains usable if the summary cannot load.
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
