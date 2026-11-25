import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketFor, resolve, resolveVersion } from '../src/index.js';
import { makeRecord } from './helpers.js';

test('bucketFor is stable across calls and always 0 to 99', () => {
  for (let i = 0; i < 1000; i++) {
    const b = bucketFor('billing', `user-${i}`);
    assert.equal(b, bucketFor('billing', `user-${i}`));
    assert.ok(Number.isInteger(b) && b >= 0 && b <= 99);
  }
});

test('bucketFor has pinned values so the algorithm cannot drift unnoticed', () => {
  assert.deepEqual(
    ['user-1', 'user-2', 'alice@example.com', 'ünïcode-用户'].map((u) => bucketFor('billing', u)),
    GOLDEN,
  );
});

test('bucketing is per module', () => {
  let differing = 0;
  for (let i = 0; i < 200; i++) {
    if (bucketFor('billing', `u${i}`) !== bucketFor('search', `u${i}`)) differing++;
  }
  assert.ok(differing > 150, `only ${differing} of 200 differ`);
});

test('share of users on next is within 2 points of rollout for 10k ids', () => {
  for (const rollout of [1, 10, 25, 50, 75, 99]) {
    const record = makeRecord({ rollout });
    let onNext = 0;
    for (let i = 0; i < 10_000; i++) {
      if (resolveVersion(record, { userId: `user-${i}` }) === '2.5.0') onNext++;
    }
    const share = onNext / 100;
    assert.ok(Math.abs(share - rollout) <= 2, `rollout ${rollout} gave ${share}`);
  }
});

test('raising the rollout only adds users to next, never removes them', () => {
  const low = makeRecord({ rollout: 20 });
  const high = makeRecord({ rollout: 40 });
  for (let i = 0; i < 2000; i++) {
    const ctx = { userId: `user-${i}` };
    if (resolveVersion(low, ctx) === '2.5.0') assert.equal(resolveVersion(high, ctx), '2.5.0');
  }
});

test('rollout 0 sends nobody to next and 100 sends everybody', () => {
  for (let i = 0; i < 500; i++) {
    const ctx = { userId: `user-${i}` };
    assert.equal(resolveVersion(makeRecord({ rollout: 0 }), ctx), '2.4.0');
    assert.equal(resolveVersion(makeRecord({ rollout: 100 }), ctx), '2.5.0');
  }
});

test('no next means current, whatever the rollout', () => {
  assert.equal(resolveVersion(makeRecord({ next: null, rollout: 100 }), { userId: 'a' }), '2.4.0');
});

test('missing user id gets current', () => {
  const r = resolve(makeRecord({ rollout: 100 }), {});
  assert.equal(r.version, '2.4.0');
  assert.equal(r.reason, 'NO_USER');
  assert.equal(r.bucket, null);
  assert.equal(resolveVersion(makeRecord({ rollout: 100 }), { userId: '' }), '2.4.0');
});

test('unhealthy current falls back to last for everyone, even users on next', () => {
  const record = makeRecord({ healthy: false, rollout: 100 });
  const r = resolve(record, { userId: 'user-1' });
  assert.equal(r.version, '2.3.1');
  assert.equal(r.channel, 'last');
  assert.equal(r.reason, 'UNHEALTHY');
});

test('unhealthy with no last keeps serving current', () => {
  const r = resolve(makeRecord({ healthy: false, last: null }), { userId: 'user-1' });
  assert.equal(r.version, '2.4.0');
  assert.equal(r.channel, 'current');
  assert.equal(r.reason, 'UNHEALTHY');
});

test('resolve reports channel and bucket', () => {
  const record = makeRecord({ rollout: 50 });
  const r = resolve(record, { userId: 'user-1' });
  assert.equal(r.bucket, bucketFor('billing', 'user-1'));
  assert.equal(r.channel, r.bucket! < 50 ? 'next' : 'current');
});

const GOLDEN: number[] = [2,67,1,0];
