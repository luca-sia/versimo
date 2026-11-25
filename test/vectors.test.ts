import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bucketFor,
  checkHealth,
  compareSemver,
  draftNext,
  isSemver,
  promote,
  resolve,
  rollback,
  rolloutFromFlag,
  setRollout,
  validateRecord,
  VersimoError,
  type ModuleRecord,
} from '../src/index.js';
import { buildVectors } from '../spec/build.js';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const vectors = JSON.parse(read('../spec/vectors.json'));

test('vectors.json is what Versimo for TypeScript generates', () => {
  assert.deepEqual(vectors, JSON.parse(JSON.stringify(buildVectors())));
});

test('the Swift copy of vectors.json matches spec/vectors.json', () => {
  assert.equal(read('../packages/swift/Tests/VersimoTests/Resources/vectors.json'), read('../spec/vectors.json'));
});

test('bucket vectors', () => {
  for (const c of vectors.bucket) assert.equal(bucketFor(c.module, c.userId), c.bucket, JSON.stringify(c));
});

test('resolve vectors', () => {
  for (const c of vectors.resolve) {
    const ctx = c.userId === null ? {} : { userId: c.userId };
    assert.deepEqual(resolve(c.record, ctx), c.expected, c.name);
  }
});

test('transition vectors', () => {
  for (const c of vectors.transitions) {
    const opts = {
      now: c.now,
      ...(c.by === undefined ? {} : { by: c.by }),
      ...(c.reason === undefined ? {} : { reason: c.reason }),
      ...(c.args.patch ? { patch: true } : {}),
    };
    const run = (): ModuleRecord => {
      if (c.op === 'promote') return promote(c.record, opts);
      if (c.op === 'rollback') return rollback(c.record, opts);
      if (c.op === 'setRollout') return setRollout(c.record, c.args.n, opts);
      return draftNext(c.record, c.args.version, opts);
    };
    if (c.error) {
      assert.throws(run, (e: VersimoError) => e.code === c.error, c.name);
    } else {
      assert.deepEqual(run(), c.expected, c.name);
    }
  }
});

test('validation vectors', () => {
  for (const c of vectors.validation) {
    const r = validateRecord(c.record);
    assert.equal(r.ok, c.ok, c.name);
    assert.deepEqual(
      r.errors.map((e) => e.split(' ')[0]),
      c.errors,
      c.name,
    );
  }
});

test('semver vectors', () => {
  for (const c of vectors.semver.compare) assert.equal(compareSemver(c.a, c.b), c.expected, `${c.a} vs ${c.b}`);
  for (const c of vectors.semver.valid) assert.equal(isSemver(c.value), c.valid, JSON.stringify(c.value));
});

test('posthog vectors', () => {
  for (const c of vectors.posthog) assert.equal(rolloutFromFlag(c.flag), c.rollout, c.name);
});

test('health vectors', () => {
  for (const c of vectors.health) {
    const opts = { now: c.now, ...(c.by === undefined ? {} : { by: c.by }) };
    const run = () => checkHealth(c.record, c.checks, c.observation, opts);
    if (c.error) {
      assert.throws(run, (e: VersimoError) => e.code === c.error, c.name);
    } else {
      assert.deepEqual(run(), c.expected, c.name);
    }
  }
});
