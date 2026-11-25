import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, postHogRollout, rolloutFromFlag, POSTHOG_DISTINCT_ID } from '../src/index.js';
import { makeRecord } from './helpers.js';

type Call = { url: string; init?: RequestInit };

function fakePostHog(answers: (() => Response)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    return next();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const flags = (entries: Record<string, unknown>) => () =>
  new Response(JSON.stringify({ flags: entries, errorsWhileComputingFlags: false }), { status: 200 });

const on = (rollout: number) => ({ enabled: true, metadata: { payload: JSON.stringify({ rollout }) } });

test('rolloutFromFlag reads the share from the payload', () => {
  assert.equal(rolloutFromFlag(on(25)), 25);
  assert.equal(rolloutFromFlag({ enabled: false }), 0);
  assert.equal(rolloutFromFlag(undefined), null);
  assert.equal(rolloutFromFlag({ enabled: true }), null);
});

test('the PostHog share drives next, bucketing still picks the users', async () => {
  const { fetchImpl } = fakePostHog([flags({ 'versimo-billing': on(100) })]);
  const client = createClient({
    source: () => makeRecord({ rollout: 0 }),
    rollout: postHogRollout({ apiKey: 'phc_test', fetch: fetchImpl }),
  });
  const r = await client.resolve('billing', { userId: 'user-42' });
  assert.equal(r.version, '2.5.0');
  assert.equal(r.channel, 'next');
  assert.equal(r.bucket, 33);
  assert.equal((await client.record('billing')).rollout, 100);
});

test('a share of 33 or less keeps user-42 (bucket 33) on current, 34 moves them', async () => {
  for (const [share, version] of [[33, '2.4.0'], [34, '2.5.0']] as const) {
    const { fetchImpl } = fakePostHog([flags({ 'versimo-billing': on(share) })]);
    const client = createClient({
      source: () => makeRecord({ rollout: 0 }),
      rollout: postHogRollout({ apiKey: 'phc_test', fetch: fetchImpl }),
    });
    assert.equal(await client.version('billing', { userId: 'user-42' }), version);
  }
});

test('turning the flag off takes everyone off next', async () => {
  const { fetchImpl } = fakePostHog([flags({ 'versimo-billing': { enabled: false } })]);
  const client = createClient({
    source: () => makeRecord({ rollout: 100 }),
    rollout: postHogRollout({ apiKey: 'phc_test', fetch: fetchImpl }),
  });
  assert.equal(await client.version('billing', { userId: 'user-42' }), '2.4.0');
});

test('no flag for the module keeps the record rollout', async () => {
  const { fetchImpl } = fakePostHog([flags({ 'versimo-search': on(0) })]);
  const client = createClient({
    source: () => makeRecord({ rollout: 100 }),
    rollout: postHogRollout({ apiKey: 'phc_test', fetch: fetchImpl }),
  });
  assert.equal(await client.version('billing', { userId: 'user-42' }), '2.5.0');
});

test('unhealthy still falls back to last whatever PostHog says', async () => {
  const { fetchImpl } = fakePostHog([flags({ 'versimo-billing': on(100) })]);
  const client = createClient({
    source: () => makeRecord({ healthy: false }),
    rollout: postHogRollout({ apiKey: 'phc_test', fetch: fetchImpl }),
  });
  assert.equal(await client.version('billing', { userId: 'user-42' }), '2.3.1');
});

test('PostHog down with no earlier answer falls back to the record rollout', async () => {
  const { fetchImpl } = fakePostHog([() => new Response('nope', { status: 503 })]);
  const client = createClient({
    source: () => makeRecord({ rollout: 100 }),
    rollout: postHogRollout({ apiKey: 'phc_test', fetch: fetchImpl }),
  });
  assert.equal(await client.version('billing', { userId: 'user-42' }), '2.5.0');
});

test('a network error falls back to the record rollout', async () => {
  const fetchImpl = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  const client = createClient({
    source: () => makeRecord({ rollout: 0 }),
    rollout: postHogRollout({ apiKey: 'phc_test', fetch: fetchImpl }),
  });
  assert.equal(await client.version('billing', { userId: 'user-42' }), '2.4.0');
});

test('PostHog down after a good answer keeps the last good answer', async () => {
  let t = 0;
  const { calls, fetchImpl } = fakePostHog([
    flags({ 'versimo-billing': on(100) }),
    () => new Response('nope', { status: 500 }),
  ]);
  const rollout = postHogRollout({ apiKey: 'phc_test', fetch: fetchImpl, ttlMs: 10, now: () => t });
  assert.equal(await rollout('billing'), 100);
  t = 10;
  assert.equal(await rollout('billing'), 100);
  assert.equal(calls.length, 2);
});

test('one request per ttl serves every module', async () => {
  let t = 0;
  const { calls, fetchImpl } = fakePostHog([flags({ 'versimo-billing': on(10), 'versimo-search': on(20) })]);
  const rollout = postHogRollout({ apiKey: 'phc_test', fetch: fetchImpl, ttlMs: 1000, now: () => t });
  assert.deepEqual(await Promise.all([rollout('billing'), rollout('search'), rollout('billing')]), [10, 20, 10]);
  assert.equal(calls.length, 1);
  t = 999;
  await rollout('search');
  assert.equal(calls.length, 1);
  t = 1000;
  await rollout('search');
  assert.equal(calls.length, 2);
});

test('a rollout change in PostHog lands without a deploy once the ttl runs out', async () => {
  let t = 0;
  const { fetchImpl } = fakePostHog([flags({ 'versimo-billing': on(0) }), flags({ 'versimo-billing': on(100) })]);
  const client = createClient({
    source: () => makeRecord({ rollout: 0 }),
    rollout: postHogRollout({ apiKey: 'phc_test', fetch: fetchImpl, ttlMs: 10, now: () => t }),
  });
  assert.equal(await client.version('billing', { userId: 'user-42' }), '2.4.0');
  t = 10;
  assert.equal(await client.version('billing', { userId: 'user-42' }), '2.5.0');
});

test('no user data is sent to PostHog', async () => {
  const { calls, fetchImpl } = fakePostHog([flags({ 'versimo-billing': on(50) })]);
  const client = createClient({
    source: () => makeRecord(),
    rollout: postHogRollout({ apiKey: 'phc_test', host: 'https://us.i.posthog.com/', fetch: fetchImpl }),
  });
  await client.resolve('billing', { userId: 'sealed-client-user-7' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://us.i.posthog.com/flags?v=2');
  assert.equal(calls[0]!.init?.method, 'POST');
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.deepEqual(body, { api_key: 'phc_test', distinct_id: POSTHOG_DISTINCT_ID });
  assert.ok(!JSON.stringify(calls).includes('sealed-client-user-7'));
});

test('default host is the EU cloud', async () => {
  const { calls, fetchImpl } = fakePostHog([flags({})]);
  await postHogRollout({ apiKey: 'phc_test', fetch: fetchImpl })('billing');
  assert.equal(calls[0]!.url, 'https://eu.i.posthog.com/flags?v=2');
});

test('a rollout source that throws or returns junk leaves the record alone', async () => {
  for (const rollout of [
    () => {
      throw new Error('boom');
    },
    () => 150,
    () => 2.5,
    () => null,
  ]) {
    const client = createClient({ source: () => makeRecord({ rollout: 100 }), rollout });
    assert.equal((await client.record('billing')).rollout, 100);
  }
});

test('postHogRollout needs an api key', () => {
  assert.throws(() => postHogRollout({ apiKey: '' }), { code: 'INVALID_INPUT' });
});
