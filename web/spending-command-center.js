let scheduled = false;
let loading = false;

const money = (value) => Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const esc = (value) => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
function previousMonth(month) {
  const [year, number] = month.split('-').map(Number);
  const date = new Date(year, number - 2, 1);
  return monthKey(date);
}
function spendingActive() {
  return Boolean(document.querySelector('main .seg-btn[data-view="spending"].active'));
}
function validPurchase(transaction, month) {
  return (transaction.posted_date || '').startsWith(month)
    && !transaction.pending && !transaction.is_transfer && !transaction.is_income
    && !transaction.parent_transaction_id && Number(transaction.amount) > 0;
}
function totals(transactions, month) {
  const category = new Map();
  const restaurantMerchants = new Map();
  for (const transaction of transactions.filter((row) => validPurchase(row, month))) {
    const key = transaction.category || 'Uncategorized';
    category.set(key, (category.get(key) || 0) + Number(transaction.amount));
    if (key === 'Restaurants') {
      const merchant = transaction.payee || 'Restaurant';
      restaurantMerchants.set(merchant, (restaurantMerchants.get(merchant) || 0) + Number(transaction.amount));
    }
  }
  return {
    categories: [...category.entries()].map(([name, amount]) => ({ name, amount })).sort((a,b) => b.amount-a.amount),
    restaurants: [...restaurantMerchants.entries()].map(([name, amount]) => ({ name, amount })).sort((a,b) => b.amount-a.amount),
  };
}
function ensureStyle() {
  if (document.getElementById('spending-command-center-style')) return;
  const style = document.createElement('style');
  style.id = 'spending-command-center-style';
  style.textContent = `
    [data-spending-command-center]{margin:2px 0 16px}
    [data-spending-command-center] .sc-card{background:var(--surface);border:1px solid var(--border);border-radius:18px;overflow:hidden;box-shadow:var(--shadow-sm)}
    [data-spending-command-center] .sc-head{padding:14px}
    [data-spending-command-center] .sc-kicker{font-size:10.5px;font-weight:820;letter-spacing:.055em;text-transform:uppercase;color:var(--muted)}
    [data-spending-command-center] .sc-total{font-size:27px;line-height:1.1;font-weight:860;letter-spacing:-.04em;margin-top:2px}
    [data-spending-command-center] .sc-note{font-size:10.8px;color:var(--muted);line-height:1.4;margin-top:3px}
    [data-spending-command-center] .sc-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 12px;padding:11px 14px;border-top:1px solid var(--border)}
    [data-spending-command-center] .sc-name{font-size:12.5px;font-weight:780;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    [data-spending-command-center] .sc-sub{font-size:10.3px;color:var(--muted);margin-top:2px}
    [data-spending-command-center] .sc-value{font-size:12.5px;font-weight:830;white-space:nowrap}
    [data-spending-command-center] .sc-empty{padding:14px;border-top:1px solid var(--border);font-size:11.5px;color:var(--muted)}
  `;
  document.head.appendChild(style);
}
function render(host, transactions) {
  const currentMonth = monthKey();
  const current = totals(transactions, currentMonth);
  const previous = totals(transactions, previousMonth(currentMonth));
  const restaurants = current.categories.find((row) => row.name === 'Restaurants')?.amount || 0;
  const previousRestaurants = previous.categories.find((row) => row.name === 'Restaurants')?.amount || 0;
  const restaurantChange = restaurants - previousRestaurants;
  const categoryRows = current.categories.filter((row) => row.name !== 'Restaurants').slice(0, 3);
  host.innerHTML = `
    <div class="sc-card">
      <div class="sc-head"><div class="sc-kicker">Restaurants this month</div><div class="sc-total">${money(restaurants)}</div><div class="sc-note">${restaurantChange === 0 ? 'About the same as last month so far.' : `${money(Math.abs(restaurantChange))} ${restaurantChange > 0 ? 'more' : 'less'} than last month so far.`} Transfers and internal household moves are excluded.</div></div>
      ${current.restaurants.length ? current.restaurants.slice(0,3).map((row) => `<div class="sc-row"><span><div class="sc-name">${esc(row.name)}</div><div class="sc-sub">Restaurant spending this month</div></span><span class="sc-value">${money(row.amount)}</span></div>`).join('') : '<div class="sc-empty">No posted restaurant purchases this month.</div>'}
    </div>
    <div class="sc-card" style="margin-top:12px">
      <div class="sc-head"><div class="sc-kicker">Where spending is going</div><div class="sc-note">Largest posted categories this month. Open a category for its transactions.</div></div>
      ${categoryRows.length ? categoryRows.map((row) => `<div class="sc-row"><span><div class="sc-name">${esc(row.name)}</div><div class="sc-sub">Posted household purchases</div></span><span class="sc-value">${money(row.amount)}</span></div>`).join('') : '<div class="sc-empty">No posted purchases to summarize yet.</div>'}
    </div>`;
}
async function run() {
  if (!spendingActive() || loading) return;
  const main = document.querySelector('main');
  if (!main || main.querySelector('[data-spending-command-center]')) return;
  loading = true;
  try {
    ensureStyle();
    const transactions = await (await import('./connect.js')).listTransactions();
    if (!spendingActive() || !main.isConnected) return;
    const host = document.createElement('section');
    host.dataset.spendingCommandCenter = '1';
    const first = main.querySelector('.seg') || main.firstChild;
    first?.insertAdjacentElement('afterend', host);
    render(host, transactions);
  } catch {
    // Existing transaction view remains usable if this summary cannot load.
  } finally {
    loading = false;
  }
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; run(); });
}
new MutationObserver(schedule).observe(document.getElementById('app') ?? document.body,{childList:true,subtree:true});
schedule();
