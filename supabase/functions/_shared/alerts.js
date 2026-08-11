// GENERATED FILE — do not edit.
// Source of truth: src/engine/alerts.js
// Regenerate with: npm run sync:shared
/**
 * Alerts.
 *
 * Evaluated after each sync. Urgent ones go to email; everything lands in-app.
 *
 * The governing constraint is restraint. An alert system that fires constantly
 * gets muted, and once muted the low-balance warning is muted with it — so the
 * feature that justifies the whole system is destroyed by the features around
 * it. Every rule here therefore has a threshold chosen to fire rarely, and
 * every alert is dismissible and keyed so it never repeats.
 */

function round(n) {
  return Number(n.toFixed(2));
}

function money(n) {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Multiple of the category's typical spend before a charge is "large". */
const LARGE_TRANSACTION_MULTIPLE = 2.5;

/** Hours without a successful sync before the data is considered stale. */
const STALE_SYNC_HOURS = 48;

/** A bill inside this window is worth flagging before it's actually overdue. */
const BILL_DUE_SOON_DAYS = 3;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Build the current alert set.
 *
 * Each alert carries a stable `key`. Dismissals are stored against that key,
 * so re-running after a sync regenerates the same alert and it stays dismissed
 * rather than reappearing every night.
 *
 * @param {object} state
 * @param {object} [state.forecast] - from projectBalance
 * @param {Array<object>} [state.bills] - active Bills (see src/domain/bill.js); paid/ignored/needsReview are skipped
 * @param {Array<object>} [state.transactions]
 * @param {object} [state.subscriptions] - from analyzeSubscriptions
 * @param {object} [state.syncHealth] - { last_success, status, institution_name }
 * @param {object} [state.budget] - { [category]: { spent, target } }
 * @param {Set<string>} [state.dismissed]
 * @param {number} [state.lowBalanceThreshold=200]
 */
export function buildAlerts(state = {}) {
  const dismissed = state.dismissed ?? new Set();
  const alerts = [];

  const push = (alert) => {
    if (!dismissed.has(alert.key)) alerts.push(alert);
  };

  // --- Sync staleness. First, because every other alert is computed from data
  // that may itself be out of date. A dashboard rendering last week's numbers
  // looks identical to a working one.
  if (state.syncHealth?.last_success) {
    const hours = (Date.now() - new Date(state.syncHealth.last_success).getTime()) / 3600000;
    if (hours > STALE_SYNC_HOURS) {
      push({
        key: `stale_sync:${new Date(state.syncHealth.last_success).toISOString().slice(0, 10)}`,
        type: 'stale_sync',
        urgent: true,
        title: 'Accounts have not synced',
        body: `Last successful sync was ${Math.floor(hours / 24)} days ago. Everything below ` +
          `may be out of date.`,
      });
    }
  }

  if (state.syncHealth?.status === 'login_required') {
    push({
      key: `reauth:${state.syncHealth.institution_name}`,
      type: 'reauth',
      urgent: true,
      title: `${state.syncHealth.institution_name} needs reconnecting`,
      body: 'Your bank ended the connection. This happens a few times a year and is not ' +
        'a problem with the app — reconnecting takes a minute.',
    });
  }

  // --- Low projected balance. The alert the system exists for.
  if (state.forecast) {
    const threshold = state.lowBalanceThreshold ?? 200;
    const low = state.forecast.lowestBeforeNextPayday;

    if (low && low.balance < threshold) {
      push({
        key: `low_balance:${low.date}`,
        type: 'low_balance',
        urgent: true,
        title: low.balance < 0 ? 'Projected to go negative' : 'Balance gets tight',
        body: low.balance < 0
          ? `On ${low.date} the balance is projected at ${money(low.balance)}, before your ` +
            `next paycheck. This is the floor projection, so a normal pay period may be ` +
            `fine — but plan for this one.`
          : `Lowest point is ${money(low.balance)} on ${low.date}. Cutting it close.`,
        date: low.date,
        amount: low.balance,
      });
    }
  }

  // --- Bills due soon or overdue.
  //
  // Overdue and due-soon get separate keys per bill rather than one that
  // updates in place: dismissing "due in 3 days" should not silence the bill
  // going overdue two days later, which is a materially more urgent state and
  // deserves its own alert even though it's the same bill.
  for (const bill of state.bills ?? []) {
    if (bill.status === 'paid' || bill.status === 'ignored' || bill.needsReview) continue;

    const dueMs = new Date(`${bill.dueDate}T00:00:00Z`).getTime();
    const todayMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    const daysUntil = Math.round((dueMs - todayMs) / 86400000);

    if (daysUntil < 0) {
      push({
        key: `bill_overdue:${bill.id}`,
        type: 'bill_overdue',
        urgent: true,
        title: `${bill.providerName} is overdue`,
        body: `${money(bill.amountDue)} was due ${bill.dueDate}.`,
        date: bill.dueDate,
        amount: bill.amountDue,
      });
    } else if (daysUntil <= BILL_DUE_SOON_DAYS) {
      push({
        key: `bill_due_soon:${bill.id}`,
        type: 'bill_due_soon',
        urgent: true,
        title: `${bill.providerName} due ${daysUntil === 0 ? 'today' : `in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`}`,
        body: `${money(bill.amountDue)} due ${bill.dueDate}.`,
        date: bill.dueDate,
        amount: bill.amountDue,
      });
    }
  }

  // --- Price increases on recurring charges.
  for (const sub of state.subscriptions?.priceIncreases ?? []) {
    push({
      key: `price_increase:${sub.payee}:${sub.priceChange.to}`,
      type: 'price_increase',
      urgent: true,
      title: `${sub.payee} went up ${sub.priceChange.changePercent}%`,
      body: `From ${money(sub.priceChange.from)} to ${money(sub.priceChange.to)} — ` +
        `${money(sub.annualImpactOfIncrease)} more a year. These are designed not to be ` +
        `noticed.`,
      amount: sub.annualImpactOfIncrease,
    });
  }

  // --- New subscription detected.
  for (const sub of state.subscriptions?.lowConfidence ?? []) {
    push({
      key: `new_subscription:${sub.payee}`,
      type: 'new_subscription',
      urgent: false,
      title: `New recurring charge: ${sub.payee}`,
      body: `${money(sub.last_amount)} ${sub.cadence}, about ${money(sub.annualCost)} a year ` +
        `if it continues. Intended?`,
      amount: sub.annualCost,
    });
  }

  // --- Duplicate services.
  for (const dup of state.subscriptions?.duplicates ?? []) {
    push({
      key: `duplicate:${dup.category}:${dup.services.length}`,
      type: 'duplicate_service',
      urgent: false,
      title: `${dup.services.length} services in ${dup.category}`,
      body: `${dup.services.map((s) => s.payee).join(', ')} — ${money(dup.combinedAnnual)} a ` +
        `year combined. Worth a look, though you may well want all of them.`,
      amount: dup.combinedAnnual,
    });
  }

  // --- Unusually large transaction, judged per category.
  //
  // A $300 grocery run is unremarkable; a $300 coffee charge is not. Comparing
  // against a single global threshold would flag every rent payment forever.
  if (state.transactions?.length) {
    const byCategory = new Map();
    for (const txn of state.transactions) {
      if (txn.is_transfer || txn.is_income || txn.amount <= 0) continue;
      const key = txn.category || 'Uncategorized';
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key).push(txn.amount);
    }

    const recent = state.transactions.filter((t) => {
      if (t.is_transfer || t.is_income || t.amount <= 0 || t.pending) return false;
      const age = (Date.now() - new Date(t.posted_date).getTime()) / 86400000;
      return age <= 7;
    });

    for (const txn of recent) {
      const key = txn.category || 'Uncategorized';
      const history = byCategory.get(key) ?? [];
      if (history.length < 4) continue;

      const typical = median(history);
      if (typical > 0 && txn.amount > typical * LARGE_TRANSACTION_MULTIPLE) {
        push({
          key: `large_txn:${txn.plaid_transaction_id}`,
          type: 'large_transaction',
          urgent: true,
          title: `Large ${key} charge`,
          body: `${money(txn.amount)} at ${txn.payee} on ${txn.posted_date}. Typical for ` +
            `${key} is ${money(typical)}.`,
          amount: round(txn.amount),
        });
      }
    }
  }

  // --- Budget exceeded.
  for (const [category, budget] of Object.entries(state.budget ?? {})) {
    if (!budget.target || budget.spent <= budget.target) continue;
    push({
      key: `budget_exceeded:${category}:${new Date().toISOString().slice(0, 7)}`,
      type: 'budget_exceeded',
      urgent: false,
      title: `${category} over budget`,
      body: `${money(budget.spent)} against a ${money(budget.target)} target.`,
      amount: round(budget.spent - budget.target),
    });
  }

  return {
    alerts,
    urgent: alerts.filter((a) => a.urgent),
    inApp: alerts,
    // Only urgent alerts email. Sending everything would train the household to
    // filter the sender, which loses the low-balance warning too.
    toEmail: alerts.filter((a) => a.urgent),
  };
}

/**
 * Format urgent alerts as an email.
 * Returns null when nothing warrants interrupting anyone.
 */
export function composeAlertEmail(alerts) {
  const urgent = alerts.filter((a) => a.urgent);
  if (!urgent.length) return null;

  const lines = urgent.map((a) => `• ${a.title}\n  ${a.body}`);
  return {
    subject: urgent.length === 1 ? urgent[0].title : `${urgent.length} things to look at`,
    body: `${lines.join('\n\n')}\n\n—\nFamily Budget`,
  };
}
