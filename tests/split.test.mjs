/**
 * Splitting one charge across categories.
 *
 * The arithmetic guarantee is the whole point: the parts must add up to the
 * parent exactly, and the parent must then be excluded from every total. Get
 * either wrong and the month's figures move without anybody spending anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { planSplit, isSplitParent, splitParentIds } from '../src/engine/split.js';
import { totalSpending } from '../src/engine/transfers.js';
import { spendingOnly } from '../src/engine/budget/monthly-budget.js';

const parent = {
  id: 'uuid-parent', plaid_transaction_id: 'plaid-parent', household_id: 'h1',
  account_id: 'a1', posted_date: '2026-08-07', amount: 312.44,
  payee: 'Costco', raw_description: 'COSTCO WHSE #0472', category: 'Groceries',
  is_transfer: false, is_income: false, pending: false,
};

test('the parts have to add up to the charge', () => {
  const short = planSplit(parent, [{ amount: 200, category: 'Groceries' }, { amount: 100, category: 'Shopping' }]);
  assert.equal(short.ok, false);
  assert.match(short.error, /12\.44 is unassigned/);

  const over = planSplit(parent, [{ amount: 300, category: 'Groceries' }, { amount: 100, category: 'Shopping' }]);
  assert.equal(over.ok, false);
  assert.match(over.error, /more than/);

  const exact = planSplit(parent, [
    { amount: 212.44, category: 'Groceries' },
    { amount: 100, category: 'Kids Supplies' },
  ]);
  assert.equal(exact.ok, true);
  assert.equal(exact.children.length, 2);
});

test('a split needs at least two parts', () => {
  const one = planSplit(parent, [{ amount: 312.44, category: 'Groceries' }]);
  assert.equal(one.ok, false);
  assert.match(one.error, /at least two/);
});

test('the unassigned remainder is reported before the part count', () => {
  // Typing one amount and leaving the other blank is the normal half-finished
  // state. "You have $112.44 unassigned" is actionable; "a split needs two
  // parts" describes the form rather than the problem.
  const half = planSplit(parent, [{ amount: 200, category: 'Groceries' }, { amount: '', category: '' }]);
  assert.equal(half.ok, false);
  assert.match(half.error, /112\.44 is unassigned/);
});

test('children carry the parent, the date and the payee, and are never re-guessed', () => {
  const { children } = planSplit(parent, [
    { amount: 212.44, category: 'Groceries' },
    { amount: 100, category: 'Kids Supplies' },
  ]);
  for (const c of children) {
    assert.equal(c.parent_transaction_id, 'uuid-parent', 'points at the database id, not the Plaid id');
    assert.equal(c.posted_date, parent.posted_date);
    assert.equal(c.payee, parent.payee);
    assert.equal(c.manually_categorized, true, 'a split is a human decision');
    assert.equal(c.categorized_by, 'split');
    assert.equal(c.pending, false);
  }
});

test('a refund splits as a refund, keeping its sign', () => {
  const refund = { ...parent, amount: -60 };
  const { children } = planSplit(refund, [{ amount: 40, category: 'Groceries' }, { amount: 20, category: 'Shopping' }]);
  assert.deepEqual(children.map((c) => c.amount), [-40, -20]);
});

test('the parent drops out of spending once it has children', () => {
  // parent_transaction_id references transactions.id — the database uuid, not
  // the Plaid string id. Every exclusion check used to compare it against
  // plaid_transaction_id, which never matches, so the parent would have been
  // counted alongside its own children and the month would double-count the
  // whole charge.
  const children = planSplit(parent, [
    { amount: 212.44, category: 'Groceries' },
    { amount: 100, category: 'Kids Supplies' },
  ]).children.map((c, i) => ({ ...c, id: `child-${i}`, plaid_transaction_id: null }));

  const all = [parent, ...children];
  assert.equal(totalSpending(all), 312.44, 'the charge counts once, not twice');
  assert.equal(spendingOnly(all).length, 2, 'the two children, not the parent');

  const parents = splitParentIds(all);
  assert.equal(isSplitParent(parent, parents), true);
  assert.equal(isSplitParent(children[0], parents), false);
});

test('a transaction with no children is not a parent', () => {
  assert.equal(isSplitParent(parent, splitParentIds([parent])), false);
  assert.equal(isSplitParent(parent, new Set()), false);
});
