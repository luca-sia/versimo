import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createApp, type Config } from '../src/app.js';
import { MemoryStore } from '../src/memory-store.js';
import { sign } from '../src/session.js';

const config: Config = {
  issuer: 'https://accounts.example',
  authorizeUrl: 'https://accounts.example/api/auth/oauth2/authorize',
  tokenUrl: 'https://accounts.example/api/auth/oauth2/token',
  userinfoUrl: 'https://accounts.example/api/auth/oauth2/userinfo',
  clientId: 'versimo',
  clientSecret: 'client-secret',
  sessionSecret: 'a-session-secret-that-is-long-enough-1234',
  appOrigin: 'https://versimo.test',
};

const ORIGIN = config.appOrigin;

interface FakeIdp {
  fetch: typeof fetch;
  calls: { url: string; body?: string; auth?: string | null }[];
}

function fakeIdp(sub = 'user-catalin', name = 'Catalin'): FakeIdp {
  const calls: FakeIdp['calls'] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, body: init?.body ? String(init.body) : undefined, auth: headers.get('authorization') });
    if (url === config.tokenUrl) {
      const params = new URLSearchParams(String(init?.body));
      if (params.get('code') !== 'good-code') return new Response('{"error":"invalid_grant"}', { status: 400 });
      return Response.json({ access_token: `token-for-${sub}`, token_type: 'Bearer' });
    }
    if (url === config.userinfoUrl) {
      if (headers.get('authorization') !== `Bearer token-for-${sub}`) return new Response('', { status: 401 });
      return Response.json({ sub, name, email: `${sub}@example.com` });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return { fetch: f, calls };
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

/** Runs the whole sign in and returns the session cookie. */
async function signIn(app: ReturnType<typeof createApp>, back = '/app') {
  const start = await app(new Request(`${ORIGIN}/api/auth/login?return=${encodeURIComponent(back)}`));
  const target = new URL(start.headers.get('location')!);
  const state = target.searchParams.get('state')!;
  const signInCookie = cookiesOf(start).versimo_signin!;
  const res = await app(
    new Request(`${ORIGIN}/app/callback?code=good-code&state=${state}`, {
      headers: { cookie: `versimo_signin=${signInCookie}` },
    }),
  );
  return { res, session: `versimo_session=${cookiesOf(res).versimo_session}` };
}

function call(app: ReturnType<typeof createApp>, session: string, method: string, path: string, body?: unknown) {
  return app(
    new Request(ORIGIN + path, {
      method,
      headers: { cookie: session, origin: ORIGIN, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

describe('sign in', () => {
  it('sends people to the issuer with PKCE, a state and the callback', async () => {
    const app = createApp({ store: new MemoryStore(), config, fetch: fakeIdp().fetch });
    const res = await app(new Request(`${ORIGIN}/api/auth/login`));
    assert.equal(res.status, 302);
    const target = new URL(res.headers.get('location')!);
    assert.equal(target.origin + target.pathname, config.authorizeUrl);
    assert.equal(target.searchParams.get('client_id'), 'versimo');
    assert.equal(target.searchParams.get('redirect_uri'), `${ORIGIN}/app/callback`);
    assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(target.searchParams.get('code_challenge'));
    assert.ok(target.searchParams.get('state'));
    assert.equal(target.searchParams.get('scope'), 'openid profile email');
    const set = res.headers.getSetCookie()[0]!;
    assert.match(set, /^versimo_signin=/);
    assert.match(set, /HttpOnly/);
    assert.match(set, /Secure/);
    assert.match(set, /Path=\/app\/callback/);
  });

  it('exchanges the code with the PKCE verifier, sets a session and goes back to the app', async () => {
    const idp = fakeIdp();
    const app = createApp({ store: new MemoryStore(), config, fetch: idp.fetch });
    const { res, session } = await signIn(app, '/app?project=1');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/app?project=1');
    const token = new URLSearchParams(idp.calls[0]!.body);
    assert.equal(token.get('grant_type'), 'authorization_code');
    assert.equal(token.get('client_secret'), 'client-secret');
    assert.ok((token.get('code_verifier') ?? '').length >= 43);
    assert.equal(idp.calls[1]!.auth, 'Bearer token-for-user-catalin');

    const me = await app(new Request(`${ORIGIN}/api/me`, { headers: { cookie: session } }));
    assert.equal(me.status, 200);
    const body = (await me.json()) as { user: { name: string; email: string } };
    assert.equal(body.user.name, 'Catalin');
    assert.equal(body.user.email, 'user-catalin@example.com');
  });

  it('refuses a callback whose state does not match', async () => {
    const app = createApp({ store: new MemoryStore(), config, fetch: fakeIdp().fetch });
    const start = await app(new Request(`${ORIGIN}/api/auth/login`));
    const res = await app(
      new Request(`${ORIGIN}/app/callback?code=good-code&state=forged`, {
        headers: { cookie: `versimo_signin=${cookiesOf(start).versimo_signin}` },
      }),
    );
    assert.equal(res.headers.get('location'), '/app?signin=expired');
    assert.equal(cookiesOf(res).versimo_session, undefined);
  });

  it('refuses a callback with no sign in cookie', async () => {
    const app = createApp({ store: new MemoryStore(), config, fetch: fakeIdp().fetch });
    const res = await app(new Request(`${ORIGIN}/app/callback?code=good-code&state=x`));
    assert.equal(res.headers.get('location'), '/app?signin=expired');
  });

  it('reports a failed code exchange without a session', async () => {
    const app = createApp({ store: new MemoryStore(), config, fetch: fakeIdp().fetch });
    const start = await app(new Request(`${ORIGIN}/api/auth/login`));
    const state = new URL(start.headers.get('location')!).searchParams.get('state');
    const res = await app(
      new Request(`${ORIGIN}/app/callback?code=bad-code&state=${state}`, {
        headers: { cookie: `versimo_signin=${cookiesOf(start).versimo_signin}` },
      }),
    );
    assert.equal(res.headers.get('location'), '/app?signin=failed');
    assert.equal(cookiesOf(res).versimo_session, undefined);
  });

  it('only returns to paths inside the app', async () => {
    const app = createApp({ store: new MemoryStore(), config, fetch: fakeIdp().fetch });
    for (const back of ['https://evil.example/app', '//evil.example', '/app\\@evil', '/admin']) {
      const { res } = await signIn(app, back);
      assert.equal(res.headers.get('location'), '/app', back);
    }
  });

  it('rejects a tampered or expired session', async () => {
    const app = createApp({ store: new MemoryStore(), config, fetch: fakeIdp().fetch });
    const { session } = await signIn(app);
    const tampered = session.slice(0, -3) + 'abc';
    const meWith = async (cookie: string) =>
      (await (await app(new Request(`${ORIGIN}/api/me`, { headers: { cookie } }))).json()) as { user: unknown };
    assert.equal((await meWith(tampered)).user, null);
    const old = await sign({ uid: 'x', name: null, email: null }, config.sessionSecret, 60, Date.now() - 3600e3);
    assert.equal((await meWith(`versimo_session=${old}`)).user, null);
    const res = await app(
      new Request(`${ORIGIN}/api/projects`, { headers: { cookie: `versimo_session=${old}` } }),
    );
    assert.equal(res.status, 401);
  });

  it('signs out by clearing the session cookie', async () => {
    const app = createApp({ store: new MemoryStore(), config, fetch: fakeIdp().fetch });
    const res = await app(new Request(`${ORIGIN}/api/auth/logout`, { method: 'POST' }));
    assert.match(res.headers.getSetCookie()[0]!, /^versimo_session=; Path=\/; Max-Age=0/);
  });
});

describe('saved projects', () => {
  it('keeps a project and its modules across requests, as after a refresh', async () => {
    const store = new MemoryStore();
    const app = createApp({ store, config, fetch: fakeIdp().fetch });
    const { session } = await signIn(app);

    const created = await call(app, session, 'POST', '/api/projects', { name: 'Shop' });
    assert.equal(created.status, 201);
    const { project } = (await created.json()) as { project: { id: string } };
    const mod = await call(app, session, 'POST', `/api/projects/${project.id}/modules`, {
      module: 'billing',
      current: '2.4.0',
      last: '2.3.1',
    });
    assert.equal(mod.status, 201);

    // A new app over the same store is what a refresh looks like to the API.
    const again = createApp({ store, config, fetch: fakeIdp().fetch });
    const list = (await (await call(again, session, 'GET', '/api/projects')).json()) as {
      projects: { name: string }[];
    };
    assert.deepEqual(
      list.projects.map((p) => p.name),
      ['Shop'],
    );
    const one = (await (await call(again, session, 'GET', `/api/projects/${project.id}`)).json()) as {
      modules: { module: string; current: string; last: string; next: null; rollout: number; healthy: boolean }[];
    };
    assert.equal(one.modules.length, 1);
    assert.equal(one.modules[0]!.module, 'billing');
    assert.equal(one.modules[0]!.current, '2.4.0');
    assert.equal(one.modules[0]!.last, '2.3.1');
    assert.equal(one.modules[0]!.healthy, true);
  });

  it('runs draft, rollout, promote and rollback with the library rules and logs each one', async () => {
    const app = createApp({ store: new MemoryStore(), config, fetch: fakeIdp().fetch });
    const { session } = await signIn(app);
    const { project } = (await (await call(app, session, 'POST', '/api/projects', { name: 'Shop' })).json()) as {
      project: { id: string };
    };
    const base = `/api/projects/${project.id}/modules`;
    await call(app, session, 'POST', base, { module: 'billing', current: '2.4.0' });

    let res = await call(app, session, 'POST', `${base}/billing/draft`, { version: '2.5.0' });
    assert.equal(res.status, 200);
    res = await call(app, session, 'POST', `${base}/billing/rollout`, { rollout: 25 });
    assert.equal(((await res.json()) as { module: { rollout: number } }).module.rollout, 25);
    res = await call(app, session, 'POST', `${base}/billing/promote`, {});
    const promoted = ((await res.json()) as { module: Record<string, unknown> }).module;
    assert.equal(promoted.current, '2.5.0');
    assert.equal(promoted.last, '2.4.0');
    assert.equal(promoted.next, null);
    assert.equal(promoted.rollout, 0);
    res = await call(app, session, 'POST', `${base}/billing/rollback`, {});
    const back = ((await res.json()) as { module: Record<string, unknown> }).module;
    assert.equal(back.current, '2.4.0');
    assert.equal(back.last, null);

    const history = (await (await call(app, session, 'GET', `/api/projects/${project.id}/history`)).json()) as {
      history: { action: string; from: string | null; to: string | null; by: string | null }[];
    };
    assert.deepEqual(
      history.history.map((h) => h.action),
      ['rollback', 'promote', 'rollout', 'draft', 'create'],
    );
    assert.deepEqual(history.history[0], {
      ...history.history[0],
      from: '2.5.0',
      to: '2.4.0',
      by: 'Catalin',
    });
  });

  it('turns library errors into 400 and keeps the module unchanged', async () => {
    const app = createApp({ store: new MemoryStore(), config, fetch: fakeIdp().fetch });
    const { session } = await signIn(app);
    const { project } = (await (await call(app, session, 'POST', '/api/projects', { name: 'Shop' })).json()) as {
      project: { id: string };
    };
    const base = `/api/projects/${project.id}/modules`;
    await call(app, session, 'POST', base, { module: 'billing', current: '2.4.0' });
    const lower = await call(app, session, 'POST', `${base}/billing/draft`, { version: '2.3.0' });
    assert.equal(lower.status, 400);
    assert.equal((await call(app, session, 'POST', `${base}/billing/promote`, {})).status, 400);
    assert.equal((await call(app, session, 'POST', `${base}/billing/rollout`, { rollout: 101 })).status, 400);
    const history = (await (await call(app, session, 'GET', `/api/projects/${project.id}/history`)).json()) as {
      history: unknown[];
    };
    assert.equal(history.history.length, 1);
  });

  it('validates new modules and refuses duplicates', async () => {
    const app = createApp({ store: new MemoryStore(), config, fetch: fakeIdp().fetch });
    const { session } = await signIn(app);
    const { project } = (await (await call(app, session, 'POST', '/api/projects', { name: 'Shop' })).json()) as {
      project: { id: string };
    };
    const base = `/api/projects/${project.id}/modules`;
    assert.equal((await call(app, session, 'POST', base, { module: 'Billing', current: '2.4.0' })).status, 400);
    assert.equal((await call(app, session, 'POST', base, { module: 'billing', current: 'two' })).status, 400);
    assert.equal(
      (await call(app, session, 'POST', base, { module: 'billing', current: '2.4.0', last: '2.5.0' })).status,
      400,
    );
    assert.equal((await call(app, session, 'POST', base, { module: 'billing', current: '2.4.0' })).status, 201);
    assert.equal((await call(app, session, 'POST', base, { module: 'billing', current: '3.0.0' })).status, 409);
    assert.equal((await call(app, session, 'POST', '/api/projects', { name: '  ' })).status, 400);
  });

  it('never shows or changes another person’s project', async () => {
    const store = new MemoryStore();
    const a = createApp({ store, config, fetch: fakeIdp('user-a', 'A').fetch });
    const b = createApp({ store, config, fetch: fakeIdp('user-b', 'B').fetch });
    const sa = (await signIn(a)).session;
    const sb = (await signIn(b)).session;
    const { project } = (await (await call(a, sa, 'POST', '/api/projects', { name: 'Mine' })).json()) as {
      project: { id: string };
    };
    await call(a, sa, 'POST', `/api/projects/${project.id}/modules`, { module: 'billing', current: '1.0.0' });

    const list = (await (await call(b, sb, 'GET', '/api/projects')).json()) as { projects: unknown[] };
    assert.equal(list.projects.length, 0);
    assert.equal((await call(b, sb, 'GET', `/api/projects/${project.id}`)).status, 404);
    assert.equal((await call(b, sb, 'GET', `/api/projects/${project.id}/history`)).status, 404);
    assert.equal((await call(b, sb, 'PATCH', `/api/projects/${project.id}`, { name: 'Taken' })).status, 404);
    assert.equal((await call(b, sb, 'DELETE', `/api/projects/${project.id}`)).status, 404);
    assert.equal(
      (await call(b, sb, 'POST', `/api/projects/${project.id}/modules/billing/draft`, { version: '1.1.0' })).status,
      404,
    );
    const still = (await (await call(a, sa, 'GET', `/api/projects/${project.id}`)).json()) as {
      project: { name: string };
      modules: { next: string | null }[];
    };
    assert.equal(still.project.name, 'Mine');
    assert.equal(still.modules[0]!.next, null);
  });

  it('needs a session, and the app origin on writes', async () => {
    const app = createApp({ store: new MemoryStore(), config, fetch: fakeIdp().fetch });
    assert.equal((await app(new Request(`${ORIGIN}/api/projects`))).status, 401);
    const { session } = await signIn(app);
    const res = await app(
      new Request(`${ORIGIN}/api/projects`, {
        method: 'POST',
        headers: { cookie: session, origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'X' }),
      }),
    );
    assert.equal(res.status, 403);
  });

  it('renames and deletes a project', async () => {
    const app = createApp({ store: new MemoryStore(), config, fetch: fakeIdp().fetch });
    const { session } = await signIn(app);
    const { project } = (await (await call(app, session, 'POST', '/api/projects', { name: 'Shop' })).json()) as {
      project: { id: string };
    };
    const renamed = await call(app, session, 'PATCH', `/api/projects/${project.id}`, { name: 'Store' });
    assert.equal(((await renamed.json()) as { project: { name: string } }).project.name, 'Store');
    assert.equal((await call(app, session, 'DELETE', `/api/projects/${project.id}`)).status, 204);
    assert.equal((await call(app, session, 'GET', `/api/projects/${project.id}`)).status, 404);
  });
});
