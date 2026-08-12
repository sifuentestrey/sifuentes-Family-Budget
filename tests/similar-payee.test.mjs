/**
 * Inheriting a category from a lookalike payee.
 *
 * The point of this layer is a shorter review queue, so the tests that matter
 * are the ones about what it must NOT infer — a wrong inheritance is worse
 * than an empty category, because nobody is asked about it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

import { payeeStem, buildStemIndex, categoryFromSimilarPayee } from '../src/engine/similar-payee.js';
import { categorizeBatch } from '../src/engine/categorize.js';

const txn = (payee, over = {}) => ({
  payee,
  plaidCategory: null,
  category: null,
  categorized_by: 'none',
  manually_categorized: false,
  ...over,
});

test('the stem is the first distinctive word', () => {
  assert.equal(payeeStem('SAFEWAY #1425'), 'safeway');
  assert.equal(payeeStem('Safeway Fuel 22'), 'safeway');
  assert.equal(payeeStem('TST* Blue Bottle'), 'blue');
});

test('a payee with nothing distinctive has no stem', () => {
  assert.equal(payeeStem('SQ *'), null, 'a processor prefix alone identifies nothing');
  assert.equal(payeeStem('POS 4471'), null, 'a store number is not a name');
  assert.equal(payeeStem('CVS'), null, 'too short to match on safely');
  assert.equal(payeeStem(''), null);
});

test('a stem seen with two different categories teaches nothing', () => {
  // Amazon is the canonical case: groceries one week, a kid's car seat the
  // next. Inheriting either would be wrong half the time.
  const index = buildStemIndex([
    txn('AMAZON MKTPL 1', { category: 'Shopping' }),
    txn('AMAZON GROCERY', { category: 'Groceries' }),
    txn('SAFEWAY #1425', { category: 'Groceries' }),
  ]);
  assert.equal(index.get('amazon'), undefined, 'ambiguous stems must be dropped');
  assert.equal(index.get('safeway'), 'Groceries');
});

test('an unknown payee inherits from its lookalike', () => {
  const index = buildStemIndex([txn('SAFEWAY #1425', { category: 'Groceries' })]);
  assert.equal(categoryFromSimilarPayee('SAFEWAY #0881', index), 'Groceries');
  assert.equal(categoryFromSimilarPayee('COSTCO WHSE', index), null);
});

test('a batch teaches itself, in either order', () => {
  // The teaching row coming *after* the row that needs it is the case a
  // single pass gets wrong. The merchant is one no shipped rule knows, so
  // inheritance is the only layer that can decide it.
  const result = categorizeBatch([
    txn('BERTELLI FARMS #0881'),
    txn('BERTELLI FARMS #1425', { category: 'Groceries', categorized_by: 'learned', manually_categorized: true }),
  ], { learned: new Map() });

  const inherited = result.find((t) => t.payee === 'BERTELLI FARMS #0881');
  assert.equal(inherited.category, 'Groceries');
  assert.equal(inherited.categorized_by, 'similar', 'recorded as an inference, not as the human decision');
});

test('inheritance never overrides a decision from a stronger layer', () => {
  const result = categorizeBatch([
    // A human put this one in Gas; a lookalike must not pull it elsewhere.
    txn('BERTELLI FUEL #22', { category: 'Gas', categorized_by: 'learned', manually_categorized: true }),
    txn('BERTELLI FARMS #1122'),
  ], { learned: new Map() });

  const known = result.find((t) => t.payee === 'BERTELLI FUEL #22');
  assert.equal(known.category, 'Gas');
  assert.equal(known.categorized_by, 'learned');
});

test('a human decision is still never touched', () => {
  const result = categorizeBatch([
    txn('BERTELLI FARMS #1425', { category: 'Groceries', categorized_by: 'learned', manually_categorized: true }),
    txn('BERTELLI FARMS #0881', { category: 'Dining Out', categorized_by: 'learned', manually_categorized: true }),
  ], { learned: new Map() });

  assert.equal(result[1].category, 'Dining Out');
});

test('the database can store the layer this produces', () => {
  // categorizeBatch's output is written straight into transactions.categorized_by
  // by reprocessWindow, so a value the enum lacks fails an entire sync — not
  // one row. The migration is the only thing standing between those.
  const enumSql = readFileSync(join(ROOT, 'supabase/migrations/0001_init.sql'), 'utf8');
  const added = readFileSync(join(ROOT, 'supabase/migrations/0020_categorized_by_similar.sql'), 'utf8');
  const declared = `${enumSql}\n${added}`;

  for (const layer of ['learned', 'rule', 'plaid_pfc', 'similar', 'llm', 'none']) {
    assert.match(declared, new RegExp(`'${layer}'`), `categorized_by cannot store '${layer}'`);
  }
});
