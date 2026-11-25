import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHealth,
  checkUrl,
  evaluateHealth,
  validateRecord,
  VersimoError,
  type HealthAlert,
} from '../src/index.js';
import { makeRecord } from './helpers.js';

const now = '2026-04-01T12:00:00.000Z';
const bad = { healthy: false, reasons: ['error rate 10% is above 5%'] };

test('evaluateHealth passes clean samples', () => {
  assert.deepEqual(evaluateHealth({ requests: 100, errors: 1 }), { healthy: true, reasons: [] });
});

test('evaluateHealth fails above the default error rate of 5%', () => {
  const r = evaluateHealth({ requests: 100, errors: 6 });
  assert.equal(r.healthy, false);
  assert.match(r.reasons[0]!, /error rate 6% is above 5%/);
});

test('evaluateHealth treats the threshold itself as healthy', () => {
  assert.equal(evaluateHealth({ requests: 100, errors: 5 }).healthy, true);
});

test('evaluateHealth honours maxErrorRate', () => {
  assert.equal(evaluateHealth({ requests: 100, errors: 6 }, { maxErrorRate: 0.1 }).healthy, true);
  assert.equal(evaluateHealth({ requests: 100, errors: 2 }, { maxErrorRate: 0.01 }).healthy, false);
});

test('evaluateHealth rejects a maxErrorRate outside 0 to 1', () => {
  assert.throws(() => evaluateHealth({ requests: 1, errors: 0 }, { maxErrorRate: 5 }), VersimoError);
});

test('evaluateHealth does not judge the error rate below minRequests', () => {
  assert.equal(evaluateHealth({ requests: 10, errors: 10 }).healthy, true);
  assert.equal(evaluateHealth({ requests: 20, errors: 20 }).healthy, false);
  assert.equal(evaluateHealth({ requests: 5, errors: 5 }, { minRequests: 5 }).healthy, false);
});

test('evaluateHealth judges latency only when a limit is set', () => {
  assert.equal(evaluateHealth({ requests: 100, errors: 0, p95Ms: 9000 }).healthy, true);
  const r = evaluateHealth({ requests: 100, errors: 0, p95Ms: 900 }, { maxP95Ms: 800 });
  assert.equal(r.healthy, false);
  assert.match(r.reasons[0]!, /p95 latency 900ms is above 800ms/);
  assert.equal(evaluateHealth({ requests: 100, errors: 0, p95Ms: 800 }, { maxP95Ms: 800 }).healthy, true);
});

test('evaluateHealth counts a failed custom check even below minRequests', () => {
  const r = evaluateHealth({ requests: 0, errors: 0, checks: [{ name: 'https://x.test/up', ok: false }, { name: 'db', ok: true }] });
  assert.equal(r.healthy, false);
  assert.deepEqual(r.reasons, ['check failed: https://x.test/up']);
});

test('evaluateHealth lists every reason', () => {
  const r = evaluateHealth(
    { requests: 100, errors: 50, p95Ms: 2000, checks: [{ name: 'db', ok: false }] },
    { maxP95Ms: 500 },
  );
  assert.equal(r.reasons.length, 3);
});

test('applyHealth keeps the record when healthy', () => {
  const record = makeRecord();
  const calls: HealthAlert[] = [];
  const after = applyHealth(record, { healthy: true, reasons: [] }, { onAlert: (a) => calls.push(a) });
  assert.deepEqual(after, makeRecord());
  assert.equal(calls.length, 0);
});

test('applyHealth rolls back to last and records history', () => {
  const record = makeRecord();
  const after = applyHealth(record, bad, { now });
  assert.equal(after.current, '2.3.1');
  assert.equal(after.last, null);
  assert.equal(after.next, null);
  assert.equal(after.rollout, 0);
  assert.equal(after.healthy, true);
  assert.equal(after.updatedAt, now);
  assert.deepEqual(after.history, [{ at: now, action: 'rollback', from: '2.4.0', to: '2.3.1', by: 'versimo-health' }]);
  assert.equal(validateRecord(after).ok, true);
});

test('applyHealth records the given actor', () => {
  const after = applyHealth(makeRecord(), bad, { now, by: 'pager' });
  assert.equal(after.history?.at(-1)?.by, 'pager');
});

test('applyHealth with no last marks the record unhealthy and records it', () => {
  const record = makeRecord({ last: null });
  const after = applyHealth(record, bad, { now });
  assert.equal(after.healthy, false);
  assert.equal(after.current, '2.4.0');
  assert.equal(after.next, '2.5.0');
  assert.equal(after.rollout, 10);
  assert.equal(after.updatedAt, now);
  assert.deepEqual(after.history, [{ at: now, action: 'rollback', from: '2.4.0', to: null, by: 'versimo-health' }]);
  assert.equal(validateRecord(after).ok, true);
});

test('applyHealth with no last and already unhealthy changes nothing and stays quiet', () => {
  const record = makeRecord({ last: null, healthy: false });
  const calls: HealthAlert[] = [];
  const after = applyHealth(record, bad, { now, onAlert: (a) => calls.push(a) });
  assert.deepEqual(after, makeRecord({ last: null, healthy: false }));
  assert.equal(calls.length, 0);
});

test('applyHealth never mutates its input', () => {
  const record = makeRecord({ history: [] });
  const copy = structuredClone(record);
  applyHealth(record, bad, { now });
  applyHealth(makeRecord({ last: null }), bad, { now });
  assert.deepEqual(record, copy);
  const noLast = makeRecord({ last: null });
  const noLastCopy = structuredClone(noLast);
  applyHealth(noLast, bad, { now });
  assert.deepEqual(noLast, noLastCopy);
});

test('applyHealth calls onAlert once, and only on change', () => {
  const calls: HealthAlert[] = [];
  const onAlert = (a: HealthAlert) => calls.push(a);
  applyHealth(makeRecord(), { healthy: true, reasons: [] }, { onAlert });
  assert.equal(calls.length, 0);
  applyHealth(makeRecord(), bad, { onAlert });
  assert.deepEqual(calls, [{ module: 'billing', action: 'rollback', reasons: bad.reasons }]);
  applyHealth(makeRecord({ last: null }), bad, { onAlert });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.action, 'unhealthy');
});

test('checkUrl is ok on a 2xx', async () => {
  const fetch = (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch;
  assert.deepEqual(await checkUrl('https://x.test/up', { fetch }), { name: 'https://x.test/up', ok: true });
});

test('checkUrl is not ok on a 500 or a redirect', async () => {
  const f500 = (async () => new Response('no', { status: 500 })) as typeof globalThis.fetch;
  const f302 = (async () => new Response(null, { status: 302 })) as typeof globalThis.fetch;
  assert.equal((await checkUrl('https://x.test/up', { fetch: f500 })).ok, false);
  assert.equal((await checkUrl('https://x.test/up', { fetch: f302 })).ok, false);
});

test('checkUrl is not ok on a timeout', async () => {
  const fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof globalThis.fetch;
  const result = await checkUrl('https://x.test/up', { fetch, timeoutMs: 20 });
  assert.equal(result.ok, false);
});

test('checkUrl times out even when fetch ignores the signal', async () => {
  const fetch = (() => new Promise(() => {})) as unknown as typeof globalThis.fetch;
  assert.equal((await checkUrl('https://x.test/up', { fetch, timeoutMs: 20 })).ok, false);
});

test('checkUrl never throws', async () => {
  const fetch = (async () => {
    throw new Error('network down');
  }) as typeof globalThis.fetch;
  assert.deepEqual(await checkUrl('https://x.test/up', { fetch }), { name: 'https://x.test/up', ok: false });
});
