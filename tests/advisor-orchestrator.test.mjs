import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAdvisorCards, routeAdvisorQuestion } from '../src/engine/advisor-orchestrator.js';

test('routes paycheck questions without invoking a strategy tier', () => {
  assert.deepEqual(routeAdvisorQuestion('When is my next paycheck?').route, 'paycheck');
  assert.equal(routeAdvisorQuestion('When is my next paycheck?').modelTier, 'fast');
});

test('routes strategic debt questions to the deep tier', () => {
  const route = routeAdvisorQuestion('What should we prioritize to pay off our student loans?');
  assert.equal(route.route, 'debt');
  assert.equal(route.modelTier, 'deep');
});

test('limits and sanitizes optional advisor detail cards', () => {
  const cards = normalizeAdvisorCards([
    { title: 'Main finding', value: '$100', detail: 'A useful detail.' },
    null,
    { title: '', value: '$0', detail: 'Missing title.' },
    { title: 'Next step', detail: 'Do this next.' },
    { title: 'Ignored fourth', detail: 'Too many.' },
  ]);
  assert.equal(cards.length, 3);
  assert.equal(cards[1].title, 'Next step');
  assert.equal(cards[2].title, 'Ignored fourth');
});
