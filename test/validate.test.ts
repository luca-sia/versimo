import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRecord } from '../src/index.js';
import { makeRecord } from './helpers.js';

const errorsOf = (v: unknown) => validateRecord(v).errors;

test('a good record passes', () => {
  assert.deepEqual(validateRecord(makeRecord()), { ok: true, errors: [] });
});

test('the shipped example passes', () => {
  const example = JSON.parse(readFileSync(new URL('../schema/examples/billing.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateRecord(example), { ok: true, errors: [] });
});

test('non-objects fail', () => {
  for (const v of [null, undefined, 'x', 1, [], true]) assert.equal(validateRecord(v).ok, false);
});

test('each bad field is reported by name', () => {
  assert.match(errorsOf(makeRecord({ module: 'Billing' })).join(), /module/);
  assert.match(errorsOf(makeRecord({ module: '' })).join(), /module/);
  assert.match(errorsOf(makeRecord({ last: '2.3' })).join(), /last/);
  assert.match(errorsOf(makeRecord({ current: 'x' })).join(), /current/);
  assert.match(errorsOf(makeRecord({ next: 5 as unknown as string })).join(), /next/);
  assert.match(errorsOf(makeRecord({ rollout: 101 })).join(), /rollout/);
  assert.match(errorsOf(makeRecord({ rollout: 2.5 })).join(), /rollout/);
  assert.match(errorsOf(makeRecord({ healthy: 'yes' as unknown as boolean })).join(), /healthy/);
  assert.match(errorsOf(makeRecord({ updatedAt: '2026-03-12' })).join(), /updatedAt/);
  assert.match(errorsOf(makeRecord({ updatedAt: '2026-13-45T00:00:00Z' })).join(), /updatedAt/);
});

test('missing fields fail', () => {
  const { current: _c, ...rest } = makeRecord();
  assert.match(errorsOf(rest).join(), /current/);
});

test('unknown keys fail', () => {
  assert.match(errorsOf({ ...makeRecord(), extra: 1 }).join(), /extra is not allowed/);
});

test('history entries are checked', () => {
  const bad = makeRecord({
    history: [
      { at: 'yesterday', action: 'explode' as never, from: 1 as never, to: null, by: 7 as never },
      'nope' as never,
    ],
  });
  const text = errorsOf(bad).join('\n');
  assert.match(text, /history\[0\]\.at/);
  assert.match(text, /history\[0\]\.action/);
  assert.match(text, /history\[0\]\.from/);
  assert.match(text, /history\[0\]\.by/);
  assert.match(text, /history\[1\] must be an object/);
  assert.match(errorsOf({ ...makeRecord(), history: {} }).join(), /history must be an array/);
});

test('ordering rules are checked', () => {
  assert.match(errorsOf(makeRecord({ next: '2.4.0' })).join(), /next must be greater/);
  assert.match(errorsOf(makeRecord({ last: '2.4.0' })).join(), /last must be lower/);
  assert.match(errorsOf(makeRecord({ next: null, rollout: 10 })).join(), /rollout must be 0/);
});
