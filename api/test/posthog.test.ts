import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createApp, type Config } from '../src/app.js';
import { MemoryStore } from '../src/memory-store.js';
import { seal, unseal } from '../src/seal.js';
import { fakeIdp, goodCode, ISSUER } from './idp.js';

const config: Config = {
  issuer: ISSUER,
  clientId: 'versimo',
  clientSecret: 'client secret',
  sessionSecret: 'a-session-secret-that-is-long-enough-1234',
  appOrigin: 'https://versimo.test',
};
const ORIGIN = config.appOrigin;
const KEY = 'phx_personal_key_for_tests_1234';

interface Flag {
  id: number;
  key: string;
  name: string;
  active: boolean;
  filters: { groups: { properties: unknown[]; rollout_percentage: number }[]; payloads: Record<string, string> };
}

/** A tiny PostHog feature flag API. `down` makes every call answer 503. */
function fakePosthog() {
  const flags: Flag[] = [];
  const seen: { method: string; url: string; auth: string | null; body: string | null }[] = [];
  const state = { down: false, nextId: 1 };
  const handle = async (url: URL, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    seen.push({ method, url: url.toString(), auth: headers.get('authorization'), body: (init.body as string) ?? null });
    if (state.down) return new Response('down', { status: 503 });
    if (headers.get('authorization') !== `Bearer ${KEY}`) return new Response('{}', { status: 401 });
    const m = url.pathname.match(/^\/api\/projects\/(\d+)\/feature_flags\/(?:(\d+)\/)?$/);
    if (!m || m[1] !== '256908') return new Response('{}', { status: 404 });
    if (method === 'GET') {
      const q = url.searchParams.get('search') ?? '';
      return Response.json({ results: flags.filter((f) => f.key.includes(q)) });
    }
    const input = JSON.parse(String(init.body));
    if (method === 'POST') {
      const flag = { id: state.nextId++, ...input } as Flag;
      flags.push(flag);
      return Response.json(flag, { status: 201 });
    }
    if (method === 'PATCH') {
      const flag = flags.find((f) => f.id === Number(m[2]));
      if (!flag) return new Response('{}', { status: 404 });
      Object.assign(flag, input);
      return Response.json(flag);
    }
    return new Response('{}', { status: 405 });
  };
  return { flags, seen, state, handle };
}

function setup() {
  const idp = fakeIdp();
  const ph = fakePosthog();
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === 'https://eu.posthog.com' || url.origin === 'https://us.posthog.com') return ph.handle(url, init);
    return idp.fetch(input, init);
  }) as typeof fetch;
  const store = new MemoryStore();
  const app = createApp({ store, config, fetch: doFetch });
  return { app, ph, store };
}

function cookiesOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const i = pair!.indexOf('=');
    out[pair!.slice(0, i)] = pair!.slice(i + 1);
  }
  return out;
}

async function signIn(app: ReturnType<typeof createApp>) {
  const start = await app(new Request(`${ORIGIN}/api/auth/login`));
  const target = new URL(start.headers.get('location')!);
  const res = await app(
    new Request(`${ORIGIN}/app/callback?code=${goodCode(target)}&state=${target.searchParams.get('state')}`, {
      headers: { cookie: `versimo_signin=${cookiesOf(start).versimo_signin}` },
    }),
  );
  return `versimo_session=${cookiesOf(res).versimo_session}`;
}

const call = (app: ReturnType<typeof createApp>, session: string, method: string, path: string, body?: unknown) =>
  app(
    new Request(ORIGIN + path, {
      method,
      headers: { cookie: session, origin: ORIGIN, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

async function projectWithModule(app: ReturnType<typeof createApp>, session: string) {
  const { project } = (await (await call(app, session, 'POST', '/api/projects', { name: 'Shop' })).json()) as {
    project: { id: string };
  };
  await call(app, session, 'POST', `/api/projects/${project.id}/modules`, { module: 'billing', current: '2.4.0' });
  return project.id;
}

const payloadOf = (flag: Flag | undefined) => JSON.parse(flag!.filters.payloads.true!);

describe('PostHog flags', () => {
  it('connects, writes a flag per module and moves it with the slider', async () => {
    const { app, ph } = setup();
    const session = await signIn(app);
    const id = await projectWithModule(app, session);

    const res = await call(app, session, 'PUT', `/api/projects/${id}/posthog`, { region: 'eu', projectId: 256908, apiKey: KEY });
    assert.equal(res.status, 200);
    const connected = (await res.json()) as { posthog: Record<string, unknown>; synced: string };
    assert.deepEqual(connected, { posthog: { region: 'eu', projectId: 256908, keyHint: 'phx_…1234' }, synced: 'synced' });
    assert.equal(ph.flags.length, 1);
    assert.equal(ph.flags[0]!.key, 'versimo-billing');
    assert.equal(ph.flags[0]!.active, true);
    assert.deepEqual(ph.flags[0]!.filters.groups, [{ properties: [], rollout_percentage: 100 }]);
    assert.deepEqual(payloadOf(ph.flags[0]), { rollout: 0 });

    const base = `/api/projects/${id}/modules/billing`;
    await call(app, session, 'POST', `${base}/draft`, { version: '2.5.0' });
    const moved = await call(app, session, 'POST', `${base}/rollout`, { rollout: 30 });
    assert.equal(((await moved.json()) as { posthog: string }).posthog, 'synced');
    assert.equal(ph.flags.length, 1, 'updated in place, not a second flag');
    assert.deepEqual(payloadOf(ph.flags[0]), { rollout: 30 });

    await call(app, session, 'POST', `${base}/promote`, {});
    assert.deepEqual(payloadOf(ph.flags[0]), { rollout: 0 });
  });

  it('a new module gets its flag at once', async () => {
    const { app, ph } = setup();
    const session = await signIn(app);
    const id = await projectWithModule(app, session);
    await call(app, session, 'PUT', `/api/projects/${id}/posthog`, { region: 'eu', projectId: 256908, apiKey: KEY });
    const res = await call(app, session, 'POST', `/api/projects/${id}/modules`, { module: 'search', current: '1.0.0' });
    assert.equal(((await res.json()) as { posthog: string }).posthog, 'synced');
    assert.deepEqual(ph.flags.map((f) => f.key).sort(), ['versimo-billing', 'versimo-search']);
  });

  it('sends only the slug and the share, never user data, and only to PostHog', async () => {
    const { app, ph } = setup();
    const session = await signIn(app);
    const id = await projectWithModule(app, session);
    await call(app, session, 'PUT', `/api/projects/${id}/posthog`, { region: 'eu', projectId: 256908, apiKey: KEY });
    await call(app, session, 'POST', `/api/projects/${id}/modules/billing/draft`, { version: '2.5.0' });
    await call(app, session, 'POST', `/api/projects/${id}/modules/billing/rollout`, { rollout: 10 });
    for (const s of ph.seen) {
      assert.ok(s.url.startsWith('https://eu.posthog.com/api/projects/256908/feature_flags/'), s.url);
      assert.equal(s.auth, `Bearer ${KEY}`);
      if (s.body) {
        const keys = Object.keys(JSON.parse(s.body)).sort();
        assert.ok(keys.every((k) => ['active', 'filters', 'key', 'name'].includes(k)), keys.join());
        assert.ok(!/sub-|@|Shop/.test(s.body), s.body);
      }
    }
  });

  it('without PostHog the slider works and says off', async () => {
    const { app, ph } = setup();
    const session = await signIn(app);
    const id = await projectWithModule(app, session);
    await call(app, session, 'POST', `/api/projects/${id}/modules/billing/draft`, { version: '2.5.0' });
    const res = await call(app, session, 'POST', `/api/projects/${id}/modules/billing/rollout`, { rollout: 20 });
    const out = (await res.json()) as { module: { rollout: number }; posthog: string };
    assert.equal(out.module.rollout, 20);
    assert.equal(out.posthog, 'off');
    assert.equal(ph.seen.length, 0);
  });

  it('PostHog down never blocks a change, it says failed', async () => {
    const { app, ph } = setup();
    const session = await signIn(app);
    const id = await projectWithModule(app, session);
    await call(app, session, 'PUT', `/api/projects/${id}/posthog`, { region: 'eu', projectId: 256908, apiKey: KEY });
    await call(app, session, 'POST', `/api/projects/${id}/modules/billing/draft`, { version: '2.5.0' });
    ph.state.down = true;
    const res = await call(app, session, 'POST', `/api/projects/${id}/modules/billing/rollout`, { rollout: 50 });
    assert.equal(res.status, 200);
    const out = (await res.json()) as { module: { rollout: number }; posthog: string };
    assert.equal(out.module.rollout, 50);
    assert.equal(out.posthog, 'failed');
  });

  it('refuses a key PostHog does not accept, and bad input', async () => {
    const { app, store } = setup();
    const session = await signIn(app);
    const id = await projectWithModule(app, session);
    const put = (body: unknown) => call(app, session, 'PUT', `/api/projects/${id}/posthog`, body);
    assert.equal((await put({ region: 'eu', projectId: 256908, apiKey: 'phx_wrong_key_123' })).status, 400);
    assert.equal((await put({ region: 'eu', projectId: 1, apiKey: KEY })).status, 400);
    assert.equal((await put({ region: 'mars', projectId: 256908, apiKey: KEY })).status, 400);
    assert.equal((await put({ region: 'eu', projectId: -3, apiKey: KEY })).status, 400);
    assert.equal((await put({ region: 'eu', projectId: 256908, apiKey: 'short' })).status, 400);
    const me = (await (await call(app, session, 'GET', '/api/me')).json()) as { user: { id: string } };
    assert.equal(await store.getPosthog(me.user.id, id), null, 'nothing saved after a refusal');
  });

  it('keeps the key sealed, shows only a hint, and disconnects', async () => {
    const { app, store } = setup();
    const session = await signIn(app);
    const id = await projectWithModule(app, session);
    await call(app, session, 'PUT', `/api/projects/${id}/posthog`, { region: 'eu', projectId: 256908, apiKey: KEY });
    const me = (await (await call(app, session, 'GET', '/api/me')).json()) as { user: { id: string } };
    const stored = await store.getPosthog(me.user.id, id);
    assert.ok(stored);
    assert.ok(!stored.sealedKey.includes(KEY));
    assert.equal(await unseal(stored.sealedKey, config.sessionSecret, 'posthog-key'), KEY);

    const got = await (await call(app, session, 'GET', `/api/projects/${id}/posthog`)).json();
    assert.deepEqual(got, { posthog: { region: 'eu', projectId: 256908, keyHint: 'phx_…1234' } });
    assert.ok(!JSON.stringify(got).includes(KEY));

    assert.equal((await call(app, session, 'DELETE', `/api/projects/${id}/posthog`)).status, 204);
    assert.deepEqual(await (await call(app, session, 'GET', `/api/projects/${id}/posthog`)).json(), { posthog: null });
  });

  it('another person cannot see or change the connection', async () => {
    const ph = fakePosthog();
    const store = new MemoryStore();
    const make = (sub: string) => {
      const idp = fakeIdp(sub, sub.toUpperCase());
      const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin === 'https://eu.posthog.com') return ph.handle(url, init);
        return idp.fetch(input, init);
      }) as typeof fetch;
      return createApp({ store, config, fetch: doFetch });
    };
    const a = make('user-a');
    const b = make('user-b');
    const sa = await signIn(a);
    const sb = await signIn(b);
    const id = await projectWithModule(a, sa);
    await call(a, sa, 'PUT', `/api/projects/${id}/posthog`, { region: 'eu', projectId: 256908, apiKey: KEY });
    assert.equal((await call(b, sb, 'GET', `/api/projects/${id}/posthog`)).status, 404);
    assert.equal((await call(b, sb, 'DELETE', `/api/projects/${id}/posthog`)).status, 404);
    assert.equal(
      (await call(b, sb, 'PUT', `/api/projects/${id}/posthog`, { region: 'eu', projectId: 256908, apiKey: KEY })).status,
      404,
    );
    const still = (await (await call(a, sa, 'GET', `/api/projects/${id}/posthog`)).json()) as { posthog: unknown };
    assert.ok(still.posthog);
  });
});

describe('seal', () => {
  it('opens only with the same secret and purpose', async () => {
    const s = await seal('hello', config.sessionSecret, 'posthog-key');
    assert.equal(await unseal(s, config.sessionSecret, 'posthog-key'), 'hello');
    assert.equal(await unseal(s, config.sessionSecret, 'other'), null);
    assert.equal(await unseal(s, 'another-secret-that-is-long-enough-12345', 'posthog-key'), null);
    assert.equal(await unseal('junk', config.sessionSecret, 'posthog-key'), null);
    assert.notEqual(await seal('hello', config.sessionSecret, 'posthog-key'), s, 'a fresh IV each time');
  });
});
