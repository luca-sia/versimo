import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftNext, promote, rollback, setRollout, validateRecord, VersimoError } from '../src/index.js';
import { makeRecord } from './helpers.js';

const now = '2026-04-01T12:00:00.000Z';

test('draftNext sets next at 0% and records history', () => {
  const before = makeRecord({ next: null, rollout: 0 });
  const after = draftNext(before, '2.5.0', { by: 'sam', now });
  assert.equal(after.next, '2.5.0');
  assert.equal(after.rollout, 0);
  assert.equal(after.updatedAt, now);
  assert.deepEqual(after.history?.at(-1), { at: now, action: 'draft', from: '2.4.0', to: '2.5.0', by: 'sam' });
  assert.equal(before.next, null, 'input is not mutated');
  assert.equal(before.history, undefined);
});

test('draftNext replaces an existing next and resets rollout', () => {
  const after = draftNext(makeRecord({ rollout: 40 }), '2.6.0', { now });
  assert.equal(after.next, '2.6.0');
  assert.equal(after.rollout, 0);
  assert.equal(after.history?.at(-1)?.from, '2.5.0');
});

test('draftNext can record a patch', () => {
  const after = draftNext(makeRecord({ current: '2.3.1', last: null, next: null, rollout: 0 }), '2.3.2', { patch: true, now });
  assert.equal(after.history?.at(-1)?.action, 'patch');
});

test('draftNext rejects bad versions and versions not above current', () => {
  const r = makeRecord();
  assert.throws(() => draftNext(r, 'banana'), VersimoError);
  assert.throws(() => draftNext(r, '2.4.0'), /greater than current/);
  assert.throws(() => draftNext(r, '2.3.0'), /greater than current/);
});

test('promote moves next to current and current to last', () => {
  const before = makeRecord({ rollout: 60, history: [] });
  const after = promote(before, { by: 'sam', now });
  assert.equal(after.last, '2.4.0');
  assert.equal(after.current, '2.5.0');
  assert.equal(after.next, null);
  assert.equal(after.rollout, 0);
  assert.equal(after.healthy, true);
  assert.deepEqual(after.history, [{ at: now, action: 'promote', from: '2.4.0', to: '2.5.0', by: 'sam' }]);
  assert.equal(before.current, '2.4.0');
});

test('promote without next throws', () => {
  assert.throws(() => promote(makeRecord({ next: null, rollout: 0 })), /next is empty/);
});

test('rollback puts last back as current and clears the rest', () => {
  const before = makeRecord({ healthy: false });
  const after = rollback(before, { now });
  assert.equal(after.current, '2.3.1');
  assert.equal(after.last, null);
  assert.equal(after.next, null);
  assert.equal(after.rollout, 0);
  assert.equal(after.healthy, true);
  assert.deepEqual(after.history?.at(-1), { at: now, action: 'rollback', from: '2.4.0', to: '2.3.1' });
});

test('rollback without last throws', () => {
  assert.throws(() => rollback(makeRecord({ last: null })), /last is empty/);
});

test('setRollout sets the share and records history', () => {
  const after = setRollout(makeRecord(), 35, { now });
  assert.equal(after.rollout, 35);
  assert.deepEqual(after.history?.at(-1), { at: now, action: 'rollout', from: '10', to: '35' });
});

test('setRollout rejects out of range, fractional values and rollout without next', () => {
  const r = makeRecord();
  for (const n of [-1, 101, 1.5, NaN]) assert.throws(() => setRollout(r, n), VersimoError, String(n));
  assert.throws(() => setRollout(makeRecord({ next: null, rollout: 0 }), 5), /next is empty/);
  assert.equal(setRollout(makeRecord({ next: null, rollout: 0 }), 0).rollout, 0);
});

test('a bad now option throws', () => {
  assert.throws(() => promote(makeRecord(), { now: 'not a date' }), VersimoError);
});

test('full cycle stays valid: draft, roll out, promote, fail, roll back, patch', () => {
  let r = makeRecord({ last: null, current: '1.0.0', next: null, rollout: 0 });
  r = draftNext(r, '1.1.0', { now });
  r = setRollout(r, 25, { now });
  r = setRollout(r, 100, { now });
  r = promote(r, { now });
  r = { ...r, healthy: false };
  r = rollback(r, { now });
  r = draftNext(r, '1.0.1', { patch: true, now });
  assert.equal(r.current, '1.0.0');
  assert.equal(r.next, '1.0.1');
  assert.deepEqual(validateRecord(r), { ok: true, errors: [] });
  assert.deepEqual(r.history?.map((h) => h.action), ['draft', 'rollout', 'rollout', 'promote', 'rollback', 'patch']);
});
