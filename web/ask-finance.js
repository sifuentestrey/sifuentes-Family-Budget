import { buildHouseholdPlan } from '../src/engine/household-plan.js';
import { analyzeSubscriptions } from '../src/engine/subscriptions.js';
import { buildReliableSubscriptionStreams } from '../src/engine/reliable-subscriptions.js';
import { buildUpcomingObligations, obligationProvidersMatch } from '../src/engine/bill-center.js';
import { detectIncomeStreams } from '../src/engine/income.js';
import { buildDinnerGuidance, merchantMatchKey, parseFinanceAdvisorIntent } from '../src/engine/finance-advisor.js';

let host = null;
let sheet = null;
let dataPromise = null;
let currentProposal = null;
let busy = false;
let lastAnalysis = null;

const money = (value) => Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function ensureStyle() {
  if (document.getElementById('ask-finance-style')) return;
  const style = document.createElement('style');
  style.id = 'ask-finance-style';
  style.textContent = `
    .af-launch{position:fixed;right:max(16px,calc((100vw - 560px)/2 + 16px));bottom:calc(74px + env(safe-area-inset-bottom));z-index:55;border:0;border-radius:999px;background:var(--text);color:var(--surface);font:inherit;font-size:12px;font-weight:850;padding:11px 15px;box-shadow:0 8px 26px rgba(0,0,0,.24);cursor:pointer}
    .af-backdrop{position:fixed;inset:0;background:rgba(3,7,14,.58);z-index:80;display:flex;align-items:flex-end;justify-content:center;padding:18px 10px 0}
    .af-sheet{width:min(540px,100%);max-height:min(82vh,760px);background:var(--surface);border:1px solid var(--border);border-radius:24px 24px 0 0;box-shadow:0 -18px 50px rgba(0,0,0,.34);display:flex;flex-direction:column;overflow:hidden;padding-bottom:env(safe-area-inset-bottom)}
    .af-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 16px 12px;border-bottom:1px solid var(--border)}
    .af-title{font-size:17px;font-weight:860;letter-spacing:-.025em}.af-sub{font-size:10.5px;line-height:1.4;color:var(--muted);margin-top:3px}.af-close{border:1px solid var(--border);background:var(--surface-2);color:var(--text);border-radius:999px;width:34px;height:34px;font:inherit;font-size:20px;cursor:pointer}
    .af-feed{overflow:auto;padding:14px 14px 6px;display:flex;flex-direction:column;gap:10px;min-height:180px}.af-msg{max-width:92%;font-size:12.5px;line-height:1.46;border-radius:15px;padding:11px 12px;background:var(--surface-2);color:var(--text)}.af-msg.user{align-self:flex-end;background:var(--text);color:var(--surface)}
    .af-card{border:1px solid var(--border);border-radius:16px;padding:13px;background:var(--surface-2)}.af-kicker{font-size:10px;color:var(--muted);font-weight:800;text-transform:uppercase;letter-spacing:.06em}.af-value{font-size:24px;font-weight:870;letter-spacing:-.035em;margin:3px 0}.af-card-title{font-size:14px;font-weight:840}.af-copy{font-size:11.5px;line-height:1.48;color:var(--text-2);margin-top:4px}.af-meta{font-size:10px;line-height:1.42;color:var(--muted);margin-top:7px}.af-callout{margin-top:10px;padding:10px;border-radius:12px;background:var(--quiet-soft);font-size:11.5px;line-height:1.45}
    .af-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:11px}.af-btn{border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:10px;padding:8px 10px;font:inherit;font-size:11px;font-weight:800;cursor:pointer}.af-btn.primary{background:var(--text);color:var(--surface);border-color:var(--text)}.af-btn:disabled{opacity:.55;cursor:wait}
    .af-quick{display:flex;gap:7px;overflow:auto;padding:9px 14px 3px}.af-chip{white-space:nowrap;border:1px solid var(--border);background:var(--surface-2);color:var(--text);border-radius:999px;padding:7px 10px;font:inherit;font-size:10.5px;font-weight:760;cursor:pointer}
    .af-form{display:flex;gap:8px;padding:10px 14px 14px;border-top:1px solid var(--border);background:var(--surface)}.af-input{flex:1;min-width:0;border:1px solid var(--border);background:var(--surface-2);color:var(--text);border-radius:12px;padding:11px 12px;font:inherit;font-size:12px}.af-send{border:0;border-radius:12px;background:var(--text);color:var(--surface);padding:0 14px;font:inherit;font-size:11px;font-weight:850;cursor:pointer}.af-send:disabled{opacity:.55}
    @media(max-width:480px){.af-backdrop{padding:8px 0 0}.af-sheet{max-height:88vh;border-radius:22px 22px 0 0}.af-launch{right:14px}}
  `;
  document.head.appendChild(style);
}

async function loadData(force = false) {
  if (force) dataPromise = null;
  if (!dataPromise) {
    dataPromise = Promise.all([import('./connect.js'), import('./bills.js'), import('./budget-targets.js')])
      .then(async ([connect, bills, targets]) => {
        if (!await connect.getSession()) return null;
        const [items, transactions, rawBills, suppressions, budgetTargets] = await Promise.all([
          connect.listConnectedItems(), connect.listTransactions(), bills.listBillsForCenter(),
          bills.listBillSuppressions(), targets.listBudgetTargets(),
        ]);
        return { connect, bills, items, transactions, rawBills, suppressions, budgetTargets };
      });
  }
  return dataPromise;
}

function accountsFrom(items) {
  return (items ?? []).flatMap((item) => (item.accounts ?? []).map((account) => ({
    ...account, institution: item.institution_name,
  })));
}

function buildContext(data) {
  const asOf = todayIso();
  const recurring = [
    ...(analyzeSubscriptions(data.transactions).bills ?? []),
    ...buildReliableSubscriptionStreams(data.transactions, { asOf }),
  ].filter((stream) => !data.suppressions.some((marker) => obligationProvidersMatch(marker.providerName, stream.payee)));
  const bills = data.rawBills.filter((bill) => !data.suppressions.some((marker) =>
    obligationProvidersMatch(marker.providerName, bill.providerName)));
  const obligations = buildUpcomingObligations({ bills, recurring, transactions: data.transactions, asOf });
  const plan = buildHouseholdPlan({
    asOf,
    accounts: accountsFrom(data.items),
    bills: obligations,
    incomeStreams: detectIncomeStreams(data.transactions),
    budgetTargets: data.budgetTargets,
    flexibleCategories: ['Groceries', 'Dining Out', 'Gas', 'Household/Fun'],
    transactions: data.transactions,
  });
  return { asOf, plan, obligations };
}

function advisorSummary(context) {
  const { plan, asOf } = context;
  return {
    asOf,
    currentFacts: {
      checkingNow: plan.facts.checking.available,
      savings: plan.facts.savings.available,
      billsDueBeforeNextPayday: plan.facts.dueBeforeNextPayday.total,
      billCountBeforeNextPayday: plan.facts.dueBeforeNextPayday.bills.length,
    },
    forecasts: {
      nextPaycheck: plan.forecasts.nextPaycheck,
      billsAssignedToNextPaycheck: plan.forecasts.nextPaycheckPlan?.billsTotal ?? null,
      expectedCheckingAfterAssignedBills: plan.forecasts.nextPaycheckPlan?.expectedCheckingAfterAssignedBills ?? null,
    },
    paycheckAllowances: plan.allowances.map((row) => ({ category: row.category, left: row.left, through: row.end })),
    attention: plan.attention,
  };
}

function append(html, kind = '') {
  const feed = sheet?.querySelector('.af-feed');
  if (!feed) return;
  const node = document.createElement('div');
  node.className = kind === 'user' ? 'af-msg user' : kind === 'message' ? 'af-msg' : '';
  node.innerHTML = html;
  feed.appendChild(node);
  feed.scrollTop = feed.scrollHeight;
}

function renderDinner(result) {
  const basis = `${result.confidence[0].toUpperCase()}${result.confidence.slice(1)} confidence · Based on ${result.basedOn.join(', ')}.`;
  const recommendation = result.recommendation
    ? `<div class="af-callout"><strong>${esc(result.recommendation.merchant)} usually runs ${money(result.recommendation.typical)}</strong><br>Recent visits were typically ${money(result.recommendation.low)}–${money(result.recommendation.high)}. ${result.status === 'needs_target' ? 'Set the Dining Out target before I call that affordable tonight.' : "That fits tonight's amount. If that sounds good, it is a reasonable choice for tonight."}</div>`
    : result.status === 'available'
      ? '<div class="af-callout">I do not have two recent visits to one restaurant that clearly fits, so I will not invent a recommendation.</div>'
      : '';
  append(`<div class="af-card">
    <div class="af-kicker">Current plan</div>
    <div class="af-card-title">${esc(result.label)}</div>
    ${result.amount === null ? '' : `<div class="af-value">${money(result.amount)}</div>`}
    <div class="af-copy">${esc(result.explanation)}</div>${recommendation}
    <div class="af-meta">${esc(basis)} No order or payment will be made.</div>
    ${result.status === 'needs_target' ? '<div class="af-actions"><button class="af-btn primary" data-af-route="budget">Set Dining Out target</button></div>' : ''}
  </div>`);
}

function closestMerchant(intent, transactions) {
  const wanted = merchantMatchKey(intent.merchant);
  const match = transactions.find((transaction) => {
    const key = merchantMatchKey(transaction.payee);
    return key === wanted || key.includes(wanted) || wanted.includes(key);
  });
  return match?.payee || intent.merchant;
}

function merchantProposal(intent, data) {
  const merchant = closestMerchant(intent, data.transactions);
  const key = merchantMatchKey(merchant);
  const matching = data.transactions.filter((transaction) => {
    const transactionKey = merchantMatchKey(transaction.payee);
    return transactionKey === key || transactionKey.includes(key) || key.includes(transactionKey);
  });
  const existingCategories = [...new Set(matching.map((row) => row.category).filter(Boolean))];
  const mixed = /walmart|target|amazon|costco|samsclub/.test(key) || existingCategories.length > 1;
  return { ...intent, merchant, pastCount: matching.length, mixed, existingCategories };
}

function renderProposal(proposal) {
  currentProposal = proposal;
  const recurring = proposal.suppressRecurring
    ? ` It will also remove ${proposal.merchant} from Bills & subscriptions without deleting any bank transaction.` : '';
  const caution = proposal.mixed
    ? `<div class="af-callout"><strong>Mixed merchant:</strong> ${esc(proposal.merchant)} may include more than ${esc(proposal.category)}. Future only is the calmer default; update past charges only if they all belong there.</div>` : '';
  append(`<div class="af-card" data-af-proposal>
    <div class="af-kicker">Needs review</div>
    <div class="af-card-title">${esc(proposal.merchant)} → ${esc(proposal.category)}</div>
    <div class="af-copy">Create a merchant-name household rule for Trey and Alexus.${esc(recurring)}</div>
    ${caution}
    <div class="af-meta">High confidence in the requested action · Based on your words. Transaction amounts will not change, and no money will move.</div>
    <div class="af-actions">
      <button class="af-btn primary" data-af-apply="future">Apply to future charges</button>
      ${proposal.pastCount ? `<button class="af-btn" data-af-apply="history">Apply + update ${proposal.pastCount} past</button>` : ''}
      <button class="af-btn" data-af-dismiss>Dismiss</button>
    </div>
  </div>`);
}

async function analyzeQuestion(text) {
  if (busy) return;
  busy = true;
  const input = sheet.querySelector('.af-input');
  const send = sheet.querySelector('.af-send');
  input.disabled = send.disabled = true;
  append(esc(text), 'user');
  input.value = '';
  try {
    const data = await loadData();
    if (!data) throw new Error('Sign in to use your household data.');
    const context = buildContext(data);
    const intent = parseFinanceAdvisorIntent(text);
    lastAnalysis = new Date();
    sheet.querySelector('[data-af-last]').textContent = `Last analysis ${lastAnalysis.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    if (intent.type === 'dinner') {
      renderDinner(buildDinnerGuidance({ asOf: context.asOf, transactions: data.transactions, plan: context.plan }));
    } else if (intent.type === 'merchant_rule') {
      renderProposal(merchantProposal(intent, data));
    } else {
      append('<div class="af-msg">Looking at the household facts…</div>');
      const pending = sheet.querySelector('.af-feed > div:last-child');
      const note = await data.connect.getAdvisorNote(advisorSummary(context), intent.question);
      pending.remove();
      append(`${esc(note.note)}<div class="af-meta">Reasoning only · Based on the current household summary. No data was changed.</div>`, 'message');
    }
  } catch (error) {
    append(`<strong>I couldn't finish that.</strong><br>${esc(error.message)}`, 'message');
  } finally {
    busy = false;
    input.disabled = send.disabled = false;
    input.focus();
  }
}

async function applyProposal(mode, button) {
  if (!currentProposal || busy) return;
  busy = true;
  sheet.querySelectorAll('[data-af-apply], [data-af-dismiss]').forEach((node) => { node.disabled = true; });
  try {
    const data = await loadData();
    const result = await data.connect.applyMerchantDecision({
      merchant: currentProposal.merchant,
      category: currentProposal.category,
      applyHistory: mode === 'history',
      matchType: 'contains',
    });
    if (currentProposal.suppressRecurring) {
      await data.bills.suppressBill({ providerName: currentProposal.merchant, category: currentProposal.category });
    }
    const proposalNode = button.closest('[data-af-proposal]');
    proposalNode.innerHTML = `<div class="af-kicker">Applied</div><div class="af-card-title">${esc(currentProposal.merchant)} now follows ${esc(currentProposal.category)}</div><div class="af-copy">The household rule is shared with Trey and Alexus.${mode === 'history' ? ` ${result.updatedTransactions} past charge${result.updatedTransactions === 1 ? '' : 's'} updated.` : ' Existing charges were left alone.'}${currentProposal.suppressRecurring ? ' It will no longer appear as a subscription.' : ''}</div><div class="af-meta">No transaction amounts changed and no money moved.</div>`;
    currentProposal = null;
    dataPromise = null;
    window.dispatchEvent(new CustomEvent('family-budget:data-changed', { detail: { source: 'ask-finance' } }));
  } catch (error) {
    append(`<strong>That was not applied.</strong><br>${esc(error.message)}`, 'message');
    sheet.querySelectorAll('[data-af-apply], [data-af-dismiss]').forEach((node) => { node.disabled = false; });
  } finally {
    busy = false;
  }
}

function open() {
  if (sheet) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'af-backdrop';
  backdrop.innerHTML = `<section class="af-sheet" role="dialog" aria-modal="true" aria-label="Ask Finance">
    <div class="af-head"><div><div class="af-title">Ask Finance</div><div class="af-sub" data-af-last>Not analyzed yet · Advice and reviewable rules only. Never payments, transfers, or trades.</div></div><button class="af-close" type="button" aria-label="Close">×</button></div>
    <div class="af-feed"><div class="af-msg">Ask a plain question or correct what the app believes. I will show the exact household facts or proposed rule before anything changes.</div></div>
    <div class="af-quick"><button class="af-chip" data-af-quick="What can we afford for dinner tonight?">Dinner tonight</button><button class="af-chip" data-af-quick="Film Alley isn't a subscription, just a movie theater we frequent">Correct a subscription</button><button class="af-chip" data-af-quick="Add a rule that Walmart adds towards grocery budget">Add grocery rule</button></div>
    <form class="af-form"><input class="af-input" aria-label="Ask Finance" autocomplete="off" placeholder="Ask or correct something…"><button class="af-send" type="submit">Send</button></form>
  </section>`;
  document.body.appendChild(backdrop);
  sheet = backdrop.querySelector('.af-sheet');
  const close = () => { backdrop.remove(); sheet = null; currentProposal = null; };
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
  sheet.querySelector('.af-close').addEventListener('click', close);
  sheet.querySelector('.af-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = sheet.querySelector('.af-input').value.trim();
    if (value) analyzeQuestion(value);
  });
  sheet.addEventListener('click', (event) => {
    const quick = event.target.closest('[data-af-quick]');
    if (quick) analyzeQuestion(quick.dataset.afQuick);
    const apply = event.target.closest('[data-af-apply]');
    if (apply) applyProposal(apply.dataset.afApply, apply);
    if (event.target.closest('[data-af-dismiss]')) {
      event.target.closest('[data-af-proposal]')?.remove();
      currentProposal = null;
    }
    const route = event.target.closest('[data-af-route]');
    if (route) { close(); window.__familyBudgetRoute?.(route.dataset.afRoute); }
  });
  sheet.querySelector('.af-input').focus();
}

async function mount() {
  if (host || !document.getElementById('app')) return;
  try {
    const { getSession } = await import('./connect.js');
    if (!await getSession()) return;
    ensureStyle();
    host = document.createElement('button');
    host.type = 'button';
    host.className = 'af-launch';
    host.textContent = 'Ask Finance';
    host.addEventListener('click', open);
    document.body.appendChild(host);
    window.__openFinanceAdvisor = open;
  } catch {
    // The core budget remains available if the optional advisor cannot mount.
  }
}

window.addEventListener('family-budget:data-changed', () => { dataPromise = null; });
new MutationObserver(mount).observe(document.getElementById('app') ?? document.body, { childList: true, subtree: true });
mount();
