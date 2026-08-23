let scheduled = false;
let loading = false;

function relativeTime(value) {
  if (!value) return 'Not analyzed yet';
  const days = Math.floor((Date.now() - Date.parse(value)) / 86_400_000);
  return days <= 0 ? 'Analyzed today' : `Analyzed ${days} day${days === 1 ? '' : 's'} ago`;
}
function confidence(value) {
  if (value === null || value === undefined) return 'Not rated';
  const percent = Math.round(Number(value) * 100);
  return percent >= 85 ? 'High confidence' : percent >= 60 ? 'Medium confidence' : 'Low confidence';
}
function esc(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
function homeActive() {
  return Boolean(document.querySelector('main [data-simple-home]'));
}
function ensureStyle() {
  if (document.getElementById('finance-brain-ui-style')) return;
  const style = document.createElement('style');
  style.id = 'finance-brain-ui-style';
  style.textContent = `
    [data-finance-brain] { margin-top:20px }
    [data-finance-brain] .fb-card{background:var(--surface);border:1px solid var(--border);border-radius:18px;overflow:hidden;box-shadow:var(--shadow-sm)}
    [data-finance-brain] .fb-head{padding:14px 14px 11px}
    [data-finance-brain] .fb-title{font-size:16px;font-weight:820;letter-spacing:-.025em}
    [data-finance-brain] .fb-sub{font-size:10.5px;color:var(--muted);margin-top:2px}
    [data-finance-brain] .fb-item{padding:12px 14px;border-top:1px solid var(--border)}
    [data-finance-brain] .fb-item-title{font-size:13px;font-weight:790}
    [data-finance-brain] .fb-message{font-size:11px;color:var(--text-2);line-height:1.4;margin-top:3px}
    [data-finance-brain] .fb-meta{font-size:10px;color:var(--muted);margin-top:5px}
    [data-finance-brain] .fb-actions{display:flex;gap:8px;margin-top:9px}
    [data-finance-brain] .fb-btn{border:1px solid var(--border);background:var(--surface-2);border-radius:9px;color:var(--text);font:inherit;font-size:11px;font-weight:780;padding:7px 10px;cursor:pointer}
    [data-finance-brain] .fb-btn.primary{background:var(--text);color:var(--surface);border-color:var(--text)}
    [data-finance-brain] .fb-empty{padding:14px;color:var(--muted);font-size:11.5px;line-height:1.4;border-top:1px solid var(--border)}
  `;
  document.head.appendChild(style);
}
function render(host, rows) {
  const pending = rows.filter((row) => row.status === 'pending').slice(0, 2);
  const already = rows.filter((row) => row.status === 'applied' || row.action === 'already_applied').slice(0, 1);
  const last = rows[0]?.created_at;
  host.innerHTML = `
    <div class="fb-card">
      <div class="fb-head"><div class="fb-title">Money check-in</div><div class="fb-sub">${relativeTime(last)} · Finance Brain only suggests; it never pays, transfers, or trades.</div></div>
      ${pending.length ? pending.map((row) => `<div class="fb-item">
        <div class="fb-item-title">${esc(row.title || 'Needs review')}</div>
        <div class="fb-message">${esc(row.message || row.reason || 'Review this household money item.')}</div>
        <div class="fb-meta">${esc(row.reason || 'Based on connected household data')} · ${confidence(row.confidence)}</div>
        <div class="fb-actions"><button class="fb-btn primary" type="button" data-finance-review>Review</button><button class="fb-btn" type="button" data-finance-dismiss="${esc(row.id)}">Dismiss</button></div>
      </div>`).join('') : '<div class="fb-empty">Nothing needs review right now.</div>'}
      ${already.length ? `<div class="fb-item"><div class="fb-item-title">Already handled</div><div class="fb-message">${esc(already[0].title || already[0].message)}</div><div class="fb-meta">${relativeTime(already[0].applied_at || already[0].created_at)}</div></div>` : ''}
    </div>`;
  host.querySelectorAll('[data-finance-review]').forEach((button) => button.addEventListener('click', () => {
    window.__openFinanceAdvisor?.();
  }));
  host.querySelectorAll('[data-finance-dismiss]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await (await import('./connect.js')).dismissAdvisorRecommendation(button.dataset.financeDismiss);
      schedule();
    } catch {
      button.disabled = false;
    }
  }));
}
async function run() {
  if (!homeActive() || loading) return;
  const home = document.querySelector('main [data-simple-home]');
  if (!home || home.querySelector('[data-finance-brain]')) return;
  loading = true;
  try {
    ensureStyle();
    const rows = await (await import('./connect.js')).listAdvisorRecommendations();
    if (!home.isConnected || !homeActive()) return;
    const host = document.createElement('section');
    host.dataset.financeBrain = '1';
    home.appendChild(host);
    render(host, rows);
  } catch {
    // Recommendations are additive; core household facts remain usable without them.
  } finally {
    loading = false;
  }
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; run(); });
}
new MutationObserver(schedule).observe(document.getElementById('app') ?? document.body, { childList:true, subtree:true });
schedule();
