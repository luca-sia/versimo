import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, VersimoError, type ModuleRecord } from '../src/index.js';
import { makeRecord } from './helpers.js';

function counting(records: Record<string, ModuleRecord>) {
  const state = { calls: 0 };
  const source = (module: string) => {
    state.calls++;
    return records[module];
  };
  return { state, source };
}

test('caches records until the ttl runs out', async () => {
  let t = 0;
  const { state, source } = counting({ billing: makeRecord() });
  const client = createClient({ source, ttlMs: 1000, now: () => t });
  await client.version('billing', { userId: 'a' });
  await client.version('billing', { userId: 'b' });
  assert.equal(state.calls, 1);
  t = 999;
  await client.record('billing');
  assert.equal(state.calls, 1);
  t = 1000;
  await client.record('billing');
  assert.equal(state.calls, 2);
});

test('a refetch picks up a changed record', async () => {
  let t = 0;
  const records = { billing: makeRecord({ rollout: 0 }) };
  const client = createClient({ source: (m) => records[m as 'billing'], ttlMs: 10, now: () => t });
  assert.equal(await client.version('billing', { userId: 'u' }), '2.4.0');
  records.billing = makeRecord({ rollout: 100 });
  assert.equal(await client.version('billing', { userId: 'u' }), '2.4.0', 'still cached');
  t = 10;
  assert.equal(await client.version('billing', { userId: 'u' }), '2.5.0');
});

test('clear drops the cache', async () => {
  const { state, source } = counting({ billing: makeRecord() });
  const client = createClient({ source });
  await client.record('billing');
  client.clear('billing');
  await client.record('billing');
  client.clear();
  await client.record('billing');
  assert.equal(state.calls, 3);
});

test('concurrent calls share one fetch', async () => {
  let calls = 0;
  const client = createClient({
    source: async () => {
      calls++;
      return makeRecord();
    },
  });
  await Promise.all([client.record('billing'), client.record('billing'), client.record('billing')]);
  assert.equal(calls, 1);
});

test('missing record throws NOT_FOUND', async () => {
  const client = createClient({ source: () => undefined });
  await assert.rejects(client.record('billing'), (e: VersimoError) => e.code === 'NOT_FOUND');
});

test('invalid record throws INVALID_RECORD', async () => {
  const client = createClient({ source: () => ({ module: 'billing' }) as unknown as ModuleRecord });
  await assert.rejects(client.record('billing'), (e: VersimoError) => e.code === 'INVALID_RECORD');
});

test('bad slug throws INVALID_INPUT and never reaches the source', async () => {
  const { state, source } = counting({});
  const client = createClient({ source });
  await assert.rejects(client.record('../etc/passwd'), (e: VersimoError) => e.code === 'INVALID_INPUT');
  assert.equal(state.calls, 0);
});

test('serves the stale record when the source fails after expiry', async () => {
  let t = 0;
  let fail = false;
  const client = createClient({
    source: () => {
      if (fail) throw new Error('down');
      return makeRecord();
    },
    ttlMs: 10,
    now: () => t,
  });
  await client.record('billing');
  fail = true;
  t = 50;
  assert.equal((await client.record('billing')).current, '2.4.0');
});

test('fails when the source fails and nothing is cached', async () => {
  const client = createClient({
    source: () => {
      throw new Error('down');
    },
  });
  await assert.rejects(client.record('billing'), (e: VersimoError) => e.code === 'SOURCE_ERROR');
});

test('URL source appends the module file name to a base URL', async () => {
  const seen: string[] = [];
  const fakeFetch = (async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify(makeRecord()), { status: 200 });
  }) as unknown as typeof fetch;
  const client = createClient({ source: 'https://example.test/records/', fetch: fakeFetch });
  await client.record('billing');
  assert.deepEqual(seen, ['https://example.test/records/billing.json']);
});

test('URL source fills a {module} placeholder', async () => {
  const seen: string[] = [];
  const fakeFetch = (async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify(makeRecord()), { status: 200 });
  }) as unknown as typeof fetch;
  const client = createClient({ source: 'https://example.test/api?m={module}', fetch: fakeFetch });
  await client.record('billing');
  assert.deepEqual(seen, ['https://example.test/api?m=billing']);
});

test('URL source maps 404 to NOT_FOUND and 500 to SOURCE_ERROR', async () => {
  const make = (status: number) =>
    createClient({ source: 'https://example.test', fetch: (async () => new Response('', { status })) as unknown as typeof fetch });
  await assert.rejects(make(404).record('billing'), (e: VersimoError) => e.code === 'NOT_FOUND');
  await assert.rejects(make(500).record('billing'), (e: VersimoError) => e.code === 'SOURCE_ERROR');
});
