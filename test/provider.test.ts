import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketFor, createClient, VersimoProvider } from '../src/index.js';
import { makeRecord } from './helpers.js';

function provider(record = makeRecord()) {
  return new VersimoProvider(createClient({ source: (m) => (m === 'billing' ? record : null) }));
}

test('returns next with reason SPLIT for a user inside the rollout', async () => {
  let userId = 'u0';
  for (let i = 0; bucketFor('billing', userId) >= 10; i++) userId = `u${i}`;
  const r = await provider().resolveStringEvaluation('billing', 'fallback', { targetingKey: userId });
  assert.deepEqual(r, { value: '2.5.0', variant: 'next', reason: 'SPLIT' });
});

test('returns current with reason STATIC for a user outside the rollout', async () => {
  let userId = 'u0';
  for (let i = 0; bucketFor('billing', userId) < 10; i++) userId = `u${i}`;
  const r = await provider().resolveStringEvaluation('billing', 'fallback', { targetingKey: userId });
  assert.deepEqual(r, { value: '2.4.0', variant: 'current', reason: 'STATIC' });
});

test('no targeting key gets current', async () => {
  const r = await provider(makeRecord({ rollout: 100 })).resolveStringEvaluation('billing', 'fallback');
  assert.equal(r.value, '2.4.0');
});

test('unhealthy gives last with reason DISABLED', async () => {
  const r = await provider(makeRecord({ healthy: false })).resolveStringEvaluation('billing', 'fallback', { targetingKey: 'x' });
  assert.deepEqual(r, { value: '2.3.1', variant: 'last', reason: 'DISABLED' });
});

test('unknown flag gives the default with FLAG_NOT_FOUND', async () => {
  const r = await provider().resolveStringEvaluation('search', 'fallback', { targetingKey: 'x' });
  assert.equal(r.value, 'fallback');
  assert.equal(r.reason, 'ERROR');
  assert.equal(r.errorCode, 'FLAG_NOT_FOUND');
});

test('source failure gives the default with GENERAL', async () => {
  const p = new VersimoProvider(createClient({ source: () => { throw new Error('down'); } }));
  const r = await p.resolveStringEvaluation('billing', 'fallback');
  assert.equal(r.value, 'fallback');
  assert.equal(r.errorCode, 'GENERAL');
});

test('other types report TYPE_MISMATCH', async () => {
  const p = provider();
  assert.equal((await p.resolveBooleanEvaluation('billing', true)).errorCode, 'TYPE_MISMATCH');
  assert.equal((await p.resolveNumberEvaluation('billing', 1)).value, 1);
  assert.deepEqual((await p.resolveObjectEvaluation('billing', { a: 1 })).value, { a: 1 });
  assert.equal(p.metadata.name, 'versimo');
});
