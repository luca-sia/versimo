import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHealth, evaluateHealth, resolve, rollback, validateRecord, HEALTH_ACTOR } from '../src/index.js';
import { makeRecord } from './helpers.js';

const NOW = '2026-04-01T10:00:00.000Z';

test('a failing current steps back to last, records why, and resolves to the old version', () => {
  const before = makeRecord({ rollout: 50 });
  const { record, verdict, rolledBack } = checkHealth(
    before,
    { maxErrorRate: 0.05 },
    { requests: 100, errors: 20 },
    { now: NOW },
  );
  assert.equal(rolledBack, true);
  assert.equal(verdict.healthy, false);
  assert.equal(record.current, '2.3.1');
  assert.equal(record.last, null);
  assert.equal(record.next, null);
  assert.equal(record.rollout, 0);
  assert.deepEqual(record.history?.at(-1), {
    at: NOW,
    action: 'rollback',
    from: '2.4.0',
    to: '2.3.1',
    by: HEALTH_ACTOR,
    reason: 'health: errorRate',
  });
  assert.equal(resolve(record, { userId: 'anyone' }).version, '2.3.1');
  assert.ok(validateRecord(record).ok, 'the new record is valid');
  assert.equal(before.current, '2.4.0', 'input not changed');
});

test('a passing check returns the same record object', () => {
  const rec = makeRecord();
  const out = checkHealth(rec, { maxLatencyMs: 500 }, { latencyMs: 100 });
  assert.equal(out.record, rec);
  assert.equal(out.rolledBack, false);
});

test('with no last the record is kept and the verdict still fails', () => {
  const rec = makeRecord({ last: null });
  const out = checkHealth(rec, { url: 'https://x.test/health' }, { urlStatus: 0 });
  assert.equal(out.record, rec);
  assert.equal(out.rolledBack, false);
  assert.deepEqual(out.verdict.failures, [{ check: 'url', value: 0, limit: null }]);
});

test('evaluateHealth does not need a record', () => {
  assert.deepEqual(evaluateHealth({ maxLatencyMs: 10 }, { latencyMs: 11 }), {
    healthy: false,
    failures: [{ check: 'latency', value: 11, limit: 10 }],
  });
});

test('a rollback reason is kept in history and passes validation', () => {
  const out = rollback(makeRecord(), { now: NOW, reason: 'manual' });
  assert.equal(out.history?.at(-1)?.reason, 'manual');
  assert.ok(validateRecord(out).ok);
});

test('NaN and Infinity limits are rejected', () => {
  assert.throws(() => evaluateHealth({ maxLatencyMs: Number.NaN }, {}), /maxLatencyMs/);
  assert.throws(() => evaluateHealth({}, { latencyMs: Number.POSITIVE_INFINITY }), /latencyMs/);
});
