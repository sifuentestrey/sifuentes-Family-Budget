import test from 'node:test';
import assert from 'node:assert/strict';
import { getConnectionReadiness, summarizeConnectionReadiness } from '../src/services/connection-readiness.js';


test('household integration map contains the intended providers without credentials', () => {
  const result = summarizeConnectionReadiness();
  assert.equal(result.total, 9);
  assert.equal(result.connected, 0);
  assert.ok(result.items.some(item => item.id === 'bofa' && item.strategy === 'plaid'));
  assert.ok(result.items.some(item => item.id === 'chase' && item.strategy === 'plaid'));
  assert.ok(result.items.some(item => item.id === 'ukg-time' && item.purpose === 'timecard'));
  assert.ok(result.items.some(item => item.id === 'ukg-payroll' && item.purpose === 'paystub'));
});

test('readiness can distinguish configured from connected', () => {
  const result = getConnectionReadiness({
    configured: new Set(['bofa', 'email']),
    connected: new Set(['bofa']),
  });

  const bofa = result.find(item => item.id === 'bofa');
  const email = result.find(item => item.id === 'email');
  const chase = result.find(item => item.id === 'chase');

  assert.equal(bofa.status, 'connected');
  assert.equal(email.status, 'ready_to_connect');
  assert.equal(chase.status, 'needs_configuration');
});

test('readiness output never contains credential fields', () => {
  const result = getConnectionReadiness();
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('access_token'), false);
  assert.equal(serialized.includes('refresh_token'), false);
  assert.equal(serialized.includes('client_secret'), false);
  assert.equal(serialized.includes('password'), false);
});
