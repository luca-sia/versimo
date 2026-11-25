import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthMonitor, VersimoError, type HealthAlert, type ModuleRecord } from '../src/index.js';
import { makeRecord } from './helpers.js';

const NOW = new Date('2026-04-01T10:00:00.000Z');

function memoryStore(initial: Record<string, ModuleRecord>) {
  const records = { ...initial };
  const writes: ModuleRecord[] = [];
  return {
    records,
    writes,
    store: {
      read: (m: string) => records[m],
      write: (r: ModuleRecord) => {
        writes.push(r);
        records[r.module] = r;
      },
    },
  };
}

type Call = { url: string; init?: RequestInit };

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { f, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('rolls back, writes the record and alerts when a check fails', async () => {
  const { store, writes, records } = memoryStore({ billing: makeRecord() });
  const alerts: HealthAlert[] = [];
  const monitor = createHealthMonitor({
    store,
    checks: { billing: { maxLatencyMs: 500 } },
    observe: () => ({ latencyMs: 900 }),
    alert: (a) => {
      alerts.push(a);
    },
    now: () => NOW,
  });
  const report = await monitor.check('billing');
  assert.equal(report.rolledBack, true);
  assert.equal(writes.length, 1);
  assert.equal(records.billing?.current, '2.3.1');
  assert.equal(records.billing?.history?.at(-1)?.reason, 'health: latency');
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0], {
    module: 'billing',
    at: NOW.toISOString(),
    version: '2.4.0',
    rolledBack: true,
    current: '2.3.1',
    failures: [{ check: 'latency', value: 900, limit: 500 }],
    text: 'Versimo: billing 2.4.0 failed its health checks (latency). Rolled back to 2.3.1.',
  });
});

test('a healthy module is not written and no alert is sent', async () => {
  const { store, writes } = memoryStore({ billing: makeRecord() });
  let alerts = 0;
  const monitor = createHealthMonitor({
    store,
    checks: { billing: { maxLatencyMs: 500 } },
    observe: () => ({ latencyMs: 100 }),
    alert: () => {
      alerts++;
    },
  });
  const report = await monitor.check('billing');
  assert.equal(report.verdict.healthy, true);
  assert.equal(writes.length, 0);
  assert.equal(alerts, 0);
});

test('with no last it alerts once per failing version, not on every check', async () => {
  const { store, writes } = memoryStore({ billing: makeRecord({ last: null }) });
  const alerts: HealthAlert[] = [];
  let latency = 900;
  const monitor = createHealthMonitor({
    store,
    checks: { billing: { maxLatencyMs: 500 } },
    observe: () => ({ latencyMs: latency }),
    alert: (a) => {
      alerts.push(a);
    },
  });
  await monitor.check('billing');
  await monitor.check('billing');
  assert.equal(writes.length, 0);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.text, 'Versimo: billing 2.4.0 failed its health checks (latency). There is no last version to roll back to.');
  latency = 100;
  await monitor.check('billing');
  latency = 900;
  await monitor.check('billing');
  assert.equal(alerts.length, 2, 'alerts again after it recovered and failed again');
});

test('fetches the check URL and treats a network error as status 0', async () => {
  const { store } = memoryStore({ billing: makeRecord() });
  const { f, calls } = fakeFetch(() => {
    throw new TypeError('connection refused');
  });
  const monitor = createHealthMonitor({ store, checks: { billing: { url: 'https://billing.test/health' } }, fetch: f });
  const report = await monitor.check('billing');
  assert.equal(calls[0]?.url, 'https://billing.test/health');
  assert.equal(report.observation.urlStatus, 0);
  assert.equal(report.rolledBack, true);
});

test('a 2xx check URL passes', async () => {
  const { store } = memoryStore({ billing: makeRecord() });
  const { f } = fakeFetch(() => new Response('ok', { status: 200 }));
  const monitor = createHealthMonitor({ store, checks: { billing: { url: 'https://billing.test/health' } }, fetch: f });
  assert.equal((await monitor.check('billing')).verdict.healthy, true);
});

test('reads error counts from PostHog for the current version', async () => {
  const { store } = memoryStore({ billing: makeRecord() });
  const { f, calls } = fakeFetch(() => json({ results: [[12, 100]] }));
  const monitor = createHealthMonitor({
    store,
    checks: { billing: { maxErrorRate: 0.05 } },
    posthog: { host: 'https://eu.posthog.com/', projectId: 42, apiKey: 'phx_test', windowMinutes: 10 },
    fetch: f,
  });
  const report = await monitor.check('billing');
  assert.deepEqual(report.observation, { requests: 100, errors: 12 });
  assert.equal(report.rolledBack, true);
  const call = calls[0]!;
  assert.equal(call.url, 'https://eu.posthog.com/api/projects/42/query/');
  assert.equal((call.init?.headers as Record<string, string>).Authorization, 'Bearer phx_test');
  const body = JSON.parse(String(call.init?.body));
  assert.equal(body.query.kind, 'HogQLQuery');
  assert.deepEqual(body.query.values, { module: 'billing', version: '2.4.0' });
  assert.match(body.query.query, /\$exception/);
  assert.match(body.query.query, /properties\.versimo_module = \{module\}/);
  assert.match(body.query.query, /toIntervalMinute\(10\)/);
});

test('PostHog is not asked when the module has no error rate check', async () => {
  const { store } = memoryStore({ billing: makeRecord() });
  const { f, calls } = fakeFetch(() => json({ results: [[0, 0]] }));
  const monitor = createHealthMonitor({
    store,
    checks: { billing: { maxLatencyMs: 500 } },
    posthog: { projectId: 1, apiKey: 'k' },
    fetch: f,
  });
  await monitor.check('billing');
  assert.equal(calls.length, 0);
});

test('a PostHog failure throws SOURCE_ERROR and does not roll back', async () => {
  const { store, writes } = memoryStore({ billing: makeRecord() });
  const { f } = fakeFetch(() => json({ detail: 'nope' }, 401));
  const monitor = createHealthMonitor({
    store,
    checks: { billing: { maxErrorRate: 0.05 } },
    posthog: { projectId: 1, apiKey: 'bad' },
    fetch: f,
  });
  await assert.rejects(monitor.check('billing'), (e: VersimoError) => e.code === 'SOURCE_ERROR');
  assert.equal(writes.length, 0);
});

test('unsafe PostHog property names are refused', async () => {
  const { store } = memoryStore({ billing: makeRecord() });
  const { f } = fakeFetch(() => json({ results: [[0, 0]] }));
  const monitor = createHealthMonitor({
    store,
    checks: { billing: { maxErrorRate: 0.05 } },
    posthog: { projectId: 1, apiKey: 'k', moduleProperty: "x = 1 OR '1'" },
    fetch: f,
  });
  await assert.rejects(monitor.check('billing'), (e: VersimoError) => e.code === 'INVALID_INPUT');
});

test('your own observation wins over PostHog', async () => {
  const { store } = memoryStore({ billing: makeRecord() });
  const { f } = fakeFetch(() => json({ results: [[50, 100]] }));
  const monitor = createHealthMonitor({
    store,
    checks: { billing: { maxErrorRate: 0.05 } },
    posthog: { projectId: 1, apiKey: 'k' },
    observe: () => ({ requests: 100, errors: 0 }),
    fetch: f,
  });
  assert.equal((await monitor.check('billing')).verdict.healthy, true);
});

test('an alert URL gets the alert as JSON with a Slack text', async () => {
  const { store } = memoryStore({ billing: makeRecord() });
  const { f, calls } = fakeFetch(() => new Response('ok'));
  const monitor = createHealthMonitor({
    store,
    checks: { billing: { maxLatencyMs: 1 } },
    observe: () => ({ latencyMs: 2 }),
    alert: 'https://hooks.slack.test/abc',
    fetch: f,
  });
  await monitor.check('billing');
  assert.equal(calls[0]?.url, 'https://hooks.slack.test/abc');
  assert.equal(calls[0]?.init?.method, 'POST');
  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(body.module, 'billing');
  assert.match(body.text, /Rolled back to 2\.3\.1/);
});

test('missing and invalid records fail before any check', async () => {
  const { store } = memoryStore({ broken: { ...makeRecord(), rollout: 500 } as ModuleRecord });
  const monitor = createHealthMonitor({ store, checks: {} });
  await assert.rejects(monitor.check('nope'), (e: VersimoError) => e.code === 'NOT_FOUND');
  await assert.rejects(monitor.check('broken'), (e: VersimoError) => e.code === 'INVALID_RECORD');
});

test('start checks every module on a timer and reports errors without stopping', async () => {
  const { store, records } = memoryStore({ billing: makeRecord() });
  const errors: string[] = [];
  let latency = 100;
  const monitor = createHealthMonitor({
    store,
    checks: { billing: { maxLatencyMs: 500 } },
    observe: () => ({ latencyMs: latency }),
    onError: (m) => errors.push(m),
  });
  const stop = monitor.start(['missing', 'billing'], 5);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(records.billing?.current, '2.4.0');
  latency = 900;
  await new Promise((r) => setTimeout(r, 30));
  stop();
  assert.equal(records.billing?.current, '2.3.1');
  assert.ok(errors.length >= 1 && errors.every((m) => m === 'missing'));
});
