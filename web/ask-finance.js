/**
 * Advisor tab — deterministic while ChatGPT Finance remains the optional
 * reasoning surface. It looks up exact ledger facts and proposes rules; it
 * never claims an aggregate summary knows a specific merchant.
 */
import { buildHouseholdPlan } from '../src/engine/household-plan.js';
import { analyzeSubscriptions } from '../src/engine/subscriptions.js';
import { buildReliableSubscriptionStreams } from '../src/engine/reliable-subscriptions.js';
import { buildUpcomingObligations, obligationProvidersMatch } from '../src/engine/bill-center.js';
import { detectIncomeStreams } from '../src/engine/income.js';
import { buildDinnerGuidance, merchantMatchKey, parseFinanceAdvisorIntent } from '../src/engine/finance-advisor.js';

let dataPromise = null;
let activeTarget = null;
let currentProposal = null;
let busy = false;

const money = (value) => Number(value || 0).toLocaleString('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 2,
});
const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const textKey = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function ensureStyle() {
  if (document.getElementById('finance-advisor-style')) return;
  const style = document.createElement('style');
  style.id = 'finance-advisor-style';
  style.textContent = `
    .fa-hero{padding:2px 0 16px}.fa-eyebrow{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
    .fa-title{font-size:25px;font-weight:850;letter-spacing:-.035em;margin-top:4px}.fa-copy{font-size:13px;line-height:1.5;color:var(--text-2);margin-top:6px}
    .fa-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-top:14px}.fa-fact{padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}
    .fa-label{font-size:10.5px;font-weight:750;color:var(--muted);text-transform:uppercase;letter-spacing:.045em}.fa-value{font-size:20px;font-weight:850;letter-spacing:-.03em;margin-top:3px}.fa-detail{font-size:11.5px;line-height:1.4;color:var(--text-2);margin-top:4px}
    .fa-question{display:flex;gap:8px}.fa-question .input{flex:1;min-width:0}.fa-feed{display:flex;flex-direction:column;gap:10px}.fa-message{padding:13px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);font-size:13px;line-height:1.5}.fa-message.user{background:var(--text);color:var(--surface);border-color:var(--text);align-self:flex-end;max-width:88%}.fa-kicker{font-size:10.5px;font-weight:800;color:var(--muted);letter-spacing:.05em;text-transform:uppercase;margin-bottom:5px}.fa-message h3{font-size:15px;margin:0 0 5px}.fa-meta{font-size:11.5px;color:var(--muted);margin-top:9px;line-height:1.45}.fa-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:11px}.fa-chips{display:flex;gap:7px;overflow:auto;padding-bottom:2px}.fa-chip{white-space:nowrap;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:999px;padding:8px 11px;font:inherit;font-size:11.5px;font-weight:700;cursor:pointer}.fa-note{padding:12px 13px;border-radius:var(--radius);background:var(--quiet-soft);font-size:12px;line-height:1.5;color:var(--text-2)}
    @media(min-width:520px){.fa-facts{grid-template-columns:repeat(3,minmax(0,1fr)}}`;
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
    asOf, accounts: accountsFrom(data.items), bills: obligations,
    incomeStreams: detectIncomeStreams(data.transactions), budgetTargets: data.budgetTargets,
    flexibleCategories: ['Groceries', 'Dining Out', 'Gas', 'Household/Fun'],
    transactions: data.transactions,
  });
  return { asOf, plan, obligations, recurring, bills };
}

function factCards(context) {
  const { plan } = context;
  const paycheck = plan.forecasts.nextPaycheck;
  const due = plan.facts.dueBeforeNextPayday;
  return `
    <div class="fa-facts">
      <div class="fa-fact"><div class="fa-label">Checking now</div><div class="fa-value">${money(plan.facts.checking.available)}</div><div class="fa-detail">Current fact · ${plan.facts.checking.accountCount || 0} checking account${plan.facts.checking.accountCount === 1 ? '' : 's'}</div></div>
      <div class="fa-fact"><div class="fa-label">Next paycheck</div><div class="fa-value">${paycheck ? money(paycheck.amount) : '—'}</div><div class="fa-detail">${paycheck ? `${esc(paycheck.date)} · ${esc(paycheck.confidence)} confidence` : 'No reliable paycheck forecast'}</div></div>
      <div class="fa-fact"><div class="fa-label">Bills before payday</div><div class="fa-value">${money(due.total)}</div><div class="fa-detail">${esc(due.label)} · ${due.bills.length} item${due.bills.length === 1 ? '' : 's'}</div></div>
    </div>`;
}

function renderShell(target, context) {
  target.innerHTML = `
    <div class="fa-hero">
      <div class="fa-eyebrow">Family money advisor</div>
      <div class="fa-title">Ask about the household plan</div>
      <div class="fa-copy">Exact app facts first. Rules are shown before they change anything. For broader advice, hand the same facts to ChatGPT Finance.</div>
      ${factCards(context)}
    </div>
    <section class="section">
      <div class="section-head"><div><div class="section-title">Ask or correct something</div><div class="section-sub">Bills, merchants, dinner, and category rules</div></div></div>
      <form class="fa-question" id="finance-advisor-form"><input class="input" name="question" autocomplete="off" placeholder="Why is BP a bill?" /><button class="btn btn-primary" type="submit">Ask</button></form>
      <div class="fa-chips" style="margin-top:10px"><button class="fa-chip" type="button" data-fa-question="Why is BP showing as a bill?">Why is BP a bill?</button><button class="fa-chip" type="button" data-fa-question="How much is Pennymac?">Pennymac amount</button><button class="fa-chip" type="button" data-fa-question="What can we afford for dinner tonight?">Dinner tonight</button><button class="fa-chip" type="button" data-fa-question="Film Alley isn't a subscription, just a movie theater we frequent">Fix Film Alley</button><button class="fa-chip" type="button" data-fa-question="Add a rule that Walmart adds towards grocery budget">Walmart groceries</button></div>
    </section>
    <section class="section"><div class="section-head"><div><div class="section-title">Advisor answers</div><div class="section-sub">Nothing here moves money or changes a record without your approval.</div></div></div><div id="finance-advisor-feed" class="fa-feed"><div class="fa-note">Start with a real household question. This tab looks up matching bills and transactions instead of guessing from a summary.</div></div></section>`;
  target.querySelector('#finance-advisor-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const question = event.currentTarget.question.value.trim();
    if (question) analyzeQuestion(question);
  });
  target.addEventListener('click', (event) => {
    const quick = event.target.closest('[data-fa-question]');
    if (quick) analyzeQuestion(quick.dataset.faQuestion);
    const apply = event.target.closest('[data-fa-apply]');
    if (apply) applyProposal(apply.dataset.faApply, apply);
    if (event.target.closest('[data-fa-dismiss]')) {
      event.target.closest('[data-fa-proposal]')?.remove();
      currentProposal = null;
    }
    const copy = event.target.closest('[data-fa-copy]');
    if (copy) copyFinancePrompt(copy);
  });
}

function feed() { return activeTarget?.querySelector('#finance-advisor-feed'); }
function append(html, kind = '') {
  const node = document.createElement('div');
  node.className = `fa-message ${kind}`;
  node.innerHTML = html;
  feed()?.append(node);
  node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return node;
}

function recentMerchantStats(merchant, transactions) {
  const key = merchantMatchKey(merchant);
  const items = transactions.filter((transaction) => {
    const amount = Number(transaction.amount);
    const transactionKey = merchantMatchKey(transaction.payee);
    return amount > 0 && !transaction.pending && !transaction.is_transfer && !transaction.is_income
      && !transaction.parent_transaction_id && (transactionKey === key || transactionKey.includes(key) || key.includes(transactionKey));
  }).sort((a, b) => String(b.posted_date || '').localeCompare(String(a.posted_date || '')));
  return { items, last: items[0] ?? null, total: items.reduce((sum, item) => sum + Number(item.amount || 0), 0) };
}

function matchScore(question, name) {
  const questionKey = merchantMatchKey(question);
  const nameKey = merchantMatchKey(name);
  if (!questionKey || !nameKey) return 0;
  if (questionKey === nameKey) return 100;
  if (questionKey.includes(nameKey) || nameKey.includes(questionKey)) return 80 + Math.min(nameKey.length, 20);
  const ignored = new Set(['what', 'when', 'why', 'much', 'bill', 'showing', 'subscription', 'amount', 'how', 'is', 'the', 'a']);
  return textKey(question).split(' ').filter((token) => token.length >= 2 && !ignored.has(token))
    .reduce((score, token) => score + (nameKey.includes(token) ? 12 : 0), 0);
}

function bestNamedMatch(question, data, context) {
  const candidates = [
    ...context.bills.map((bill) => ({ kind: 'tracked', name: bill.providerName, item: bill })),
    ...context.obligations.map((bill) => ({ kind: bill.source === 'bank' ? 'recurring' : 'tracked', name: bill.providerName, item: bill })),
    ...data.transactions.map((transaction) => ({ kind: 'transaction', name: transaction.payee, item: transaction })),
  ].map((candidate) => ({ ...candidate, score: matchScore(question, candidate.name) }))
    .filter((candidate) => candidate.score >= 24)
    .sort((a, b) => b.score - a.score || String(b.item.dueDate || b.item.posted_date || '').localeCompare(String(a.item.dueDate || a.item.posted_date || '')));
  return candidates[0] ?? null;
}

function sourceLabel(bill) {
  return bill.source === 'bank' ? 'recurring estimate from bank history' : 'tracked bill amount';
}

function factAnswer(question, data, context) {
  const match = bestNamedMatch(question, data, context);
  if (!match) return null;
  const wantsWhy = /\bwhy\b|\bshowing\b|\bbill\b|\bsubscription\b|\brecurring\b/i.test(question);
  if (match.kind === 'tracked' || match.kind === 'recurring') {
    const bill = match.item;
    const recurring = match.kind === 'recurring' || bill.source === 'bank';
    const title = wantsWhy ? `Why ${match.name} appears in the plan` : `${match.name} in the household plan`;
    const amount = Number(bill.amountDue ?? bill.amount_due ?? 0);
    const dueDate = bill.dueDate || bill.due_date;
    return `<div class="fa-kicker">Exact match</div><h3>${esc(title)}</h3><strong>${money(amount)}</strong>${dueDate ? ` · ${esc(bill.paid ? 'paid' : `due ${dueDate}`)}` : ''}<div class="fa-copy">${recurring ? `This is a ${esc(sourceLabel(bill))}. It is not a verified statement unless you add or confirm the bill itself.` : `This is a ${esc(sourceLabel(bill))} in the ledger.`}</div><div class="fa-meta">Based on the matching ${recurring ? 'recurring stream' : 'bill record'} named “${esc(match.name)}”.</div>`;
  }
  const stats = recentMerchantStats(match.name, data.transactions);
  const last = stats.last;
  return `<div class="fa-kicker">Matching transaction history</div><h3>${esc(match.name)}</h3><strong>${last ? money(last.amount) : '—'}</strong>${last?.posted_date ? ` · latest charge ${esc(last.posted_date)}` : ''}<div class="fa-copy">I found ${stats.items.length} matching posted charge${stats.items.length === 1 ? '' : 's'} totaling ${money(stats.total)}. It is not currently a tracked bill.</div><div class="fa-meta">Based on matching transactions only; transfers, income, pending charges, and split parents are excluded.</div>`;
}

function renderDinner(result) {
  const recommendation = result.recommendation
    ? `<div class="fa-note" style="margin-top:10px"><strong>${esc(result.recommendation.merchant)} usually costs ${money(result.recommendation.typical)}.</strong> Recent visits were typically ${money(result.recommendation.low)}–${money(result.recommendation.high)}.</div>`
    : '';
  append(`<div class="fa-kicker">Current paycheck plan</div><h3>${esc(result.label)}</h3>${result.amount === null ? '' : `<strong>${money(result.amount)}</strong>`}<div class="fa-copy">${esc(result.explanation)}</div>${recommendation}<div class="fa-meta">${esc(result.confidence)} confidence · Based on ${esc(result.basedOn.join(', '))}. No order or payment will be made.</div>`);
}

function closestMerchant(intent, transactions) {
  const wanted = merchantMatchKey(intent.merchant);
  return transactions.find((transaction) => {
    const key = merchantMatchKey(transaction.payee);
    return key === wanted || key.includes(wanted) || wanted.includes(key);
  })?.payee || intent.merchant;
}

function merchantProposal(intent, data) {
  const merchant = closestMerchant(intent, data.transactions);
  const key = merchantMatchKey(merchant);
  const matching = data.transactions.filter((transaction) => {
    const transactionKey = merchantMatchKey(transaction.payee);
    return transactionKey === key || transactionKey.includes(key) || key.includes(transactionKey);
  });
  const existingCategories = [...new Set(matching.map((row) => row.category).filter(Boolean))];
  return { ...intent, merchant, pastCount: matching.length, mixed: /walmart|target|amazon|costco|samsclub/.test(key) || existingCategories.length > 1 };
}

function renderProposal(proposal) {
  currentProposal = proposal;
  const caution = proposal.mixed ? '<div class="fa-note" style="margin-top:10px"><strong>Mixed merchant:</strong> future charges are the safe default. Apply to past charges only if they all belong in this category.</div>' : '';
  append(`<div data-fa-proposal><div class="fa-kicker">Needs your review</div><h3>${esc(proposal.merchant)} → ${esc(proposal.category)}</h3><div class="fa-copy">This creates a shared household rule. ${proposal.suppressRecurring ? 'It also removes this merchant from recurring bills without deleting its bank history.' : ''}</div>${caution}<div class="fa-actions"><button class="btn btn-primary btn-sm" data-fa-apply="future">Apply to future charges</button>${proposal.pastCount ? `<button class="btn btn-outline btn-sm" data-fa-apply="history">Apply + update ${proposal.pastCount} past</button>` : ''}<button class="linkbtn quiet" data-fa-dismiss>Dismiss</button></div><div class="fa-meta">No money moves. Amounts do not change.</div></div>`);
}

function financePrompt(question, context) {
  const { plan } = context;
  const paycheck = plan.forecasts.nextPaycheck;
  return `Act as our household financial advisor. Answer this question using the facts below. Separate current facts from forecasts. Do not invent missing values or suggest autonomous payments/transfers.\n\nQuestion: ${question}\n\nCurrent facts:\n- Checking now: ${money(plan.facts.checking.available)}\n- Bills due before next paycheck: ${money(plan.facts.dueBeforeNextPayday.total)} (${plan.facts.dueBeforeNextPayday.bills.length} bills)\n- Savings: ${money(plan.facts.savings.available)}\n\nForecasts:\n- Next paycheck: ${paycheck ? `${money(paycheck.amount)} on ${paycheck.date}; ${paycheck.confidence} confidence; based on ${paycheck.basis}` : 'No reliable forecast'}\n- Bills assigned to that paycheck: ${money(plan.forecasts.nextPaycheckPlan?.billsTotal ?? 0)}\n\nGive a calm, decisive answer and explain the specific evidence used.`;
}

async function copyFinancePrompt(button) {
  const question = button.dataset.faCopy;
  const data = await loadData();
  const context = buildContext(data);
  try {
    await navigator.clipboard.writeText(financePrompt(question, context));
    button.textContent = 'Copied — paste into ChatGPT Finance';
  } catch {
    button.textContent = 'Could not copy on this browser';
  }
}

async function analyzeQuestion(question) {
  if (busy || !activeTarget) return;
  busy = true;
  const input = activeTarget.querySelector('[name="question"]');
  const submit = activeTarget.querySelector('#finance-advisor-form button');
  input.disabled = submit.disabled = true;
  append(esc(question), 'user');
  input.value = '';
  try {
    const data = await loadData();
    const context = buildContext(data);
    const intent = parseFinanceAdvisorIntent(question);
    if (intent.type === 'dinner') renderDinner(buildDinnerGuidance({ asOf: context.asOf, transactions: data.transactions, plan: context.plan }));
    else if (intent.type === 'merchant_rule') renderProposal(merchantProposal(intent, data));
    else {
      const answer = factAnswer(question, data, context);
      if (answer) append(answer);
      else append(`<div class="fa-kicker">Finance handoff</div><h3>I do not want to guess at that.</h3><div class="fa-copy">This tab can answer exact ledger and rule questions without an AI service. Copy a grounded prompt for ChatGPT Finance; it includes the current checking, bills, and paycheck facts shown above.</div><div class="fa-actions"><button class="btn btn-primary btn-sm" data-fa-copy="${esc(question)}">Copy Finance prompt</button></div><div class="fa-meta">No app data changes when you copy or ask.</div>`);
    }
  } catch (error) {
    append(`<strong>I couldn't read the household facts.</strong><div class="fa-copy">${esc(error.message)}</div>`);
  } finally {
    busy = false;
    input.disabled = submit.disabled = false;
    input.focus();
  }
}

async function applyProposal(mode, button) {
  if (!currentProposal || busy) return;
  busy = true;
  activeTarget.querySelectorAll('[data-fa-apply], [data-fa-dismiss]').forEach((node) => { node.disabled = true; });
  try {
    const data = await loadData();
    const result = await data.connect.applyMerchantDecision({ merchant: currentProposal.merchant, category: currentProposal.category, applyHistory: mode === 'history', matchType: 'contains' });
    if (currentProposal.suppressRecurring) await data.bills.suppressBill({ providerName: currentProposal.merchant, category: currentProposal.category });
    button.closest('[data-fa-proposal]').innerHTML = `<div class="fa-kicker">Applied</div><h3>${esc(currentProposal.merchant)} now follows ${esc(currentProposal.category)}</h3><div class="fa-copy">The household rule is shared with Trey and Alexus.${mode === 'history' ? ` ${result.updatedTransactions} past charge${result.updatedTransactions === 1 ? '' : 's'} updated.` : ' Existing charges were left alone.'}</div><div class="fa-meta">No transaction amounts changed and no money moved.</div>`;
    currentProposal = null;
    dataPromise = null;
    window.dispatchEvent(new CustomEvent('family-budget:data-changed', { detail: { source: 'advisor-rule' } }));
  } catch (error) {
    append(`<strong>That was not fully applied.</strong><div class="fa-copy">${esc(error.message)}</div>`);
    activeTarget.querySelectorAll('[data-fa-apply], [data-fa-dismiss]').forEach((node) => { node.disabled = false; });
  } finally { busy = false; }
}

async function mount() {
  const target = document.getElementById('finance-advisor-tab');
  if (!target || target === activeTarget) return;
  activeTarget = target;
  ensureStyle();
  try {
    const data = await loadData();
    if (!data || target !== activeTarget) return;
    renderShell(target, buildContext(data));
  } catch (error) {
    target.innerHTML = `<div class="banner banner-warn"><div class="banner-body"><strong>Advisor could not load.</strong> ${esc(error.message)}</div></div>`;
  }
}

window.addEventListener('family-budget:data-changed', () => { dataPromise = null; });
new MutationObserver(mount).observe(document.getElementById('app') ?? document.body, { childList: true, subtree: true });
mount();
