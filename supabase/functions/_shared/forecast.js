// GENERATED FILE — do not edit.
// Source of truth: src/engine/forecast.js
// Regenerate with: npm run sync:shared
/**
 * Cash-flow forecast and net worth.
 *
 * The forecast walks the balance forward day by day, applying projected
 * paydays and bills, and reports the lowest point before the next paycheck.
 * That single number — how close to zero this household gets, and on which
 * date — is what actually prevents overdrafts.
 *
 * With variable income it must project the FLOOR, not the average. A forecast
 * built on typical pay says "you'll be fine" in exactly the pay periods where
 * the household won't be, which is worse than showing nothing: it converts a
 * near-miss into an overdraft by removing the warning.
 */

import { projectNext } from './cadence.js';

function round(n) {
  return Number(n.toFixed(2));
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Project a daily balance.
 *
 * @param {object} input
 * @param {number} input.openingBalance - today's spendable cash
 * @param {string} input.startDate
 * @param {number} [input.days=45]
 * @param {Array<object>} input.incomeStreams - with distribution + cadence
 * @param {Array<object>} input.bills - [{ payee, amount, dueDay }]
 * @param {number} input.dailyNecessary - groceries/gas per day
 * @param {'floor'|'median'} [input.basis='floor']
 */
export function projectBalance(input) {
  const {
    openingBalance,
    startDate,
    days = 45,
    incomeStreams = [],
    bills = [],
    dailyNecessary = 0,
    basis = 'floor',
  } = input;

  // Pre-compute deposit dates for each stream across the window.
  const deposits = new Map();
  for (const stream of incomeStreams) {
    const amount = stream.distribution
      ? (basis === 'floor' ? stream.distribution.floor : stream.distribution.median)
      : stream.typical_amount;

    let cursor = stream.next_expected ?? stream.last_seen;
    let guard = 0;
    while (cursor && cursor < startDate && guard++ < 200) {
      cursor = projectNext(cursor, stream.cadence);
    }
    while (cursor && cursor <= addDays(startDate, days) && guard++ < 200) {
      deposits.set(cursor, (deposits.get(cursor) || 0) + amount);
      cursor = projectNext(cursor, stream.cadence);
    }
  }

  let balance = openingBalance;
  let low = { balance: openingBalance, date: startDate };
  const timeline = [];

  for (let i = 0; i <= days; i++) {
    const date = addDays(startDate, i);
    const dayOfMonth = new Date(date).getUTCDate();

    const income = deposits.get(date) || 0;
    const dueToday = bills.filter((b) => b.dueDay === dayOfMonth);
    const billTotal = dueToday.reduce((s, b) => s + b.amount, 0);

    balance += income - billTotal - dailyNecessary;

    if (balance < low.balance) low = { balance: round(balance), date };

    timeline.push({
      date,
      balance: round(balance),
      income: round(income),
      bills: round(billTotal),
      billNames: dueToday.map((b) => b.payee),
    });
  }

  const nextPayday = [...deposits.keys()].sort()[0] ?? null;
  const lowBeforePayday = nextPayday
    ? timeline.filter((d) => d.date <= nextPayday).reduce((min, d) => (d.balance < min.balance ? d : min), timeline[0])
    : low;

  return {
    basis,
    openingBalance: round(openingBalance),
    timeline,
    lowestPoint: low,
    lowestBeforeNextPayday: { balance: lowBeforePayday.balance, date: lowBeforePayday.date },
    nextPayday,
    goesNegative: low.balance < 0,
    // What the household can spend today without causing the low point to go
    // negative. The practical output — a single number that answers "can I?"
    safeToSpendToday: round(Math.max(0, low.balance)),
  };
}

/**
 * Net worth from account balances.
 *
 * Free tier only: bank, card, and loan balances, which arrive with the
 * Transactions product at no extra cost. Investment and retirement accounts
 * need paid Plaid add-ons and are therefore absent — reported explicitly as
 * "not connected" rather than omitted, because a missing 401k rendered as a
 * blank space reads as a zero, and a household's net worth looking far worse
 * than it is undermines every other number in the app.
 */
export function calculateNetWorth(accounts, opts = {}) {
  const assets = [];
  const liabilities = [];

  for (const account of accounts) {
    const balance = account.current_balance ?? 0;
    const entry = {
      nickname: account.nickname ?? account.name,
      type: account.type,
      mask: account.mask,
      balance: round(Math.abs(balance)),
    };

    if (account.type === 'credit' || account.type === 'loan') {
      liabilities.push(entry);
    } else {
      assets.push(entry);
    }
  }

  const totalAssets = assets.reduce((s, a) => s + a.balance, 0);
  const totalLiabilities = liabilities.reduce((s, l) => s + l.balance, 0);

  return {
    assets,
    liabilities,
    totalAssets: round(totalAssets),
    totalLiabilities: round(totalLiabilities),
    netWorth: round(totalAssets - totalLiabilities),
    investmentsConnected: Boolean(opts.investmentsConnected),
    note: opts.investmentsConnected
      ? null
      : 'Retirement and brokerage accounts are not connected — those need a paid ' +
        'Plaid add-on. This figure covers cash, cards, and loans only, so it is ' +
        'not your total net worth.',
  };
}
