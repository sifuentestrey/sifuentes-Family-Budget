// GENERATED FILE — do not edit.
// Source of truth: src/engine/advisor-orchestrator.js
// Regenerate with: npm run sync:shared
/**
 * Deterministic routing for the household advisor.
 *
 * This deliberately does not calculate money. The existing household-plan
 * engines own every number; this module only selects the reasoning lens an LLM
 * should use and whether the question deserves the more capable model tier.
 */

const ROUTES = [
  ['debt', /\b(debt|loans?|credit cards?|interest|apr|payoff|snowball|avalanche|student loans?)\b/i],
  ['savings', /\b(save|saving|savings|emergency fund|goal|vacation|down payment|sinking fund)\b/i],
  ['paycheck', /\b(paycheck|pay day|payday|pay period|hours|overtime|standby|callback|differential|ukg|paystub)\b/i],
  ['bills', /\b(bill|due|mortgage|utility|utilities|subscription|recurring|pennymac|advancial|tvec)\b/i],
  ['spending', /\b(spend|spending|afford|budget|category|grocer|restaurant|dinner|gas|purchase|buy)\b/i],
  ['cash_flow', /\b(checking|balance|cash flow|cashflow|before payday|cover|shortfall|surplus)\b/i],
];

const STRATEGY_PATTERN = /\b(strategy|plan|prioritize|priority|best way|what should|how should|compare|tradeoff|pay off|long term|next month|this year|can we afford)\b/i;

const SPECIALISTS = {
  cash_flow: 'Cash-flow specialist: reconcile current checking, bills before payday, and forecast confidence. Protect against timing gaps.',
  paycheck: 'Paycheck specialist: distinguish recorded hours and pay rules from forecast income. Never present a forecast as posted pay.',
  bills: 'Bill specialist: prefer verified bill records over recurring estimates and focus on due dates, duplicates, and paycheck assignment.',
  spending: 'Spending specialist: compare the relevant paycheck-period category target, actual spending, and household cash constraints.',
  savings: 'Savings specialist: balance the stated goal against bill coverage and cash-flow stability. Do not invent a goal or target.',
  debt: 'Debt specialist: use only debts, balances, rates, and minimums present in the context. If a required term is missing, identify it.',
  general: 'Household finance generalist: answer from the supplied facts, choose the most relevant financial lens, and avoid generic advice.',
};

export function routeAdvisorQuestion(question) {
  const text = String(question ?? '').trim();
  const route = ROUTES.find(([, pattern]) => pattern.test(text))?.[0] ?? 'general';
  const strategic = STRATEGY_PATTERN.test(text) || text.length > 240;
  return {
    route,
    strategic,
    specialist: SPECIALISTS[route],
    modelTier: strategic ? 'deep' : 'fast',
  };
}

export function normalizeAdvisorCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards.flatMap((card) => {
    if (!card || typeof card !== 'object') return [];
    const title = String(card.title ?? '').trim();
    const detail = String(card.detail ?? '').trim();
    if (!title || !detail) return [];
    return [{
      title: title.slice(0, 80),
      value: String(card.value ?? '').trim().slice(0, 60),
      detail: detail.slice(0, 280),
    }];
  }).slice(0, 3);
}
