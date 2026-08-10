/**
 * Run the full engine against synthetic fixtures and print what it produces.
 *
 * Useful for eyeballing behavior without a database, a bank connection, or any
 * real data. `npm run demo`
 */

import { readFileSync } from 'node:fs';
import {
  normalizePlaidTransaction,
  categorizeBatch,
  categorizationStats,
} from '../src/engine/categorize.js';
import { detectTransfers, totalSpending } from '../src/engine/transfers.js';
import { detectIncomeStreams, markIncome, projectMonthlyIncome } from '../src/engine/income.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/sample-plaid.json', import.meta.url)));

let txns = fixture.transactions.map((t) => normalizePlaidTransaction(t, t.account_id));
txns = detectTransfers(txns);
const streams = detectIncomeStreams(txns);
txns = markIncome(txns, streams);
txns = categorizeBatch(txns, { learned: new Map() });

const money = (n) => `$${n.toFixed(2).padStart(9)}`;
const heading = (s) => console.log(`\n${s}\n${'-'.repeat(s.length)}`);

heading('INCOME STREAMS (detected from deposits)');
for (const s of streams) {
  console.log(`  ${s.payee.padEnd(30)} ${s.cadence.padEnd(12)} ${money(s.typical_amount)}  next ${s.next_expected}`);
}

heading('PROJECTED MONTHLY INCOME');
console.log('  Note the July jump: the biweekly earner gets a third paycheck.');
console.log('  A budget assuming "biweekly = 2x per month" misses it every year.\n');
for (const m of [6, 7, 8, 9]) {
  const p = projectMonthlyIncome(streams, 2026, m);
  const checks = p.detail.map((d) => `${d.paychecks}`).join(' + ');
  console.log(`  2026-${String(m).padStart(2, '0')}  ${money(p.total)}   (${checks} paychecks)`);
}

heading('JULY 2026 SPENDING BY CATEGORY');
const july = txns.filter(
  (t) => t.posted_date.startsWith('2026-07') && !t.is_transfer && !t.is_income && !t.pending && t.amount > 0,
);
const byCategory = {};
for (const t of july) {
  const key = t.category || '(uncategorized)';
  byCategory[key] = (byCategory[key] || 0) + t.amount;
}
for (const [name, amount] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name.padEnd(24)} ${money(amount)}`);
}
console.log(`  ${'TOTAL'.padEnd(24)} ${money(july.reduce((s, t) => s + t.amount, 0))}`);

heading('EXCLUDED AS TRANSFERS (not spending)');
console.log('  These already counted at the point of purchase. Counting them');
console.log('  again is the single most common way a budget tool goes wrong.\n');
const transfers = txns.filter((t) => t.is_transfer);
for (const t of transfers) {
  console.log(`  ${t.posted_date}  ${money(t.amount)}  ${t.payee}`);
}
const inflated = transfers.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
console.log(`\n  Without this logic, spending would be overstated by ${money(inflated)}.`);

heading('CATEGORIZATION COVERAGE');
const stats = categorizationStats(txns.filter((t) => !t.is_transfer && !t.is_income));
console.log(`  ${stats.coverage}% categorized automatically (${stats.total} transactions)`);
console.log(`  by layer: ${JSON.stringify(stats.counts)}`);
console.log(`  ${stats.counts.none} went to the review queue rather than being guessed at.`);

heading('TOTALS');
console.log(`  All-time spending (transfers, income, pending excluded): ${money(totalSpending(txns))}`);
console.log();
