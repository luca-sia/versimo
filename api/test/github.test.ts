import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { createApp, type Config } from '../src/app.js';
import { MemoryStore } from '../src/memory-store.js';
import { sign } from '../src/session.js';

const ORIGIN = 'https://versimo.test';
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const base: Config = {
  issuer: 'https://accounts.example/api/auth',
  clientId: 'versimo',
  clientSecret: 'client-secret',
  sessionSecret: 'a-session-secret-that-is-long-enough-1234',
  appOrigin: ORIGIN,
};

const config: Config = {
  ...base,
  github: {
    appId: '123',
    slug: 'versimo',
    privateKey,
    webhookSecret: 'hook-secret',
    clientId: 'gh-client',
    clientSecret: 'gh-secret',
  },
};

interface GitHubState {
  /** Installations each user code can see. */
  userInstalls: Record<string, number[]>;
  repos: Record<number, string[]>;
  tags: Record<string, string[]>;
  calls: string[];
}

function fakeGitHub(state: Partial<GitHubState> = {}) {
  const s: GitHubState = {
    userInstalls: { 'good-code': [42] },
    repos: { 42: ['acme/shop'] },
    tags: { 'acme/shop': ['billing/v2.4.0', 'billing/v2.3.1', 'search/v1.0.0-rc.1', 'v9.9.9'] },
    calls: [],
    ...state,
  };
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    s.calls.push(`${method} ${url.pathname}`);
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    if (url.href === 'https://github.com/login/oauth/access_token') {
      const { code, client_secret } = JSON.parse(String(init?.body));
      if (client_secret !== 'gh-secret' || !s.userInstalls[code]) return Response.json({ error: 'bad_verification_code' });
      return Response.json({ access_token: `user-${code}` });
    }
    if (url.pathname === '/user/installations') {
      const code = auth.replace('Bearer user-', '');
      return Response.json({ installations: (s.userInstalls[code] ?? []).map((id) => ({ id })) });
    }
    const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (tokenMatch && method === 'POST') {
      assert.match(auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      return Response.json({ token: `inst-${tokenMatch[1]}`, expires_at: '2026-11-26T00:00:00Z' }, { status: 201 });
    }
    if (url.pathname === '/installation/repositories') {
      const id = Number(auth.replace('Bearer inst-', ''));
      return Response.json({ repositories: (s.repos[id] ?? []).map((full_name) => ({ full_name })) });
    }
    const tagMatch = /^\/repos\/([^/]+)\/([^/]+)\/tags$/.exec(url.pathname);
    if (tagMatch) {
      const names = s.tags[`${tagMatch[1]}/${tagMatch[2]}`] ?? [];
      return Response.json(url.searchParams.get('page') === '1' ? names.map((name) => ({ name })) : []);
    }
    return new Response('{"message":"Not Found"}', { status: 404 });
  }) as typeof fetch;
  return { fetch: f, state: s };
}

async function setup(cfg: Config = config, gh = fakeGitHub()) {
  const store = new MemoryStore();
  const user = await store.upsertUser({ issuer: base.issuer, subject: 'catalin', email: 'c@example.com', name: 'Catalin' });
  const project = await store.createProject(user.id, 'Shop');
  const token = await sign({ uid: user.id, name: 'Catalin', email: 'c@example.com' }, base.sessionSecret, 3600);
  const app = createApp({ store, config: cfg, fetch: gh.fetch });
  const session = `versimo_session=${token}`;
  const call = (method: string, path: string, body?: unknown) =>
    app(
      new Request(ORIGIN + path, {
        method,
        headers: { cookie: session, origin: ORIGIN, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { store, user, project, app, session, call, gh };
}

async function installState(app: ReturnType<typeof createApp>, session: string, projectId: string) {
  const res = await app(new Request(`${ORIGIN}/api/projects/${projectId}/github/install`, { headers: { cookie: session } }));
  assert.equal(res.status, 302);
  const target = new URL(res.headers.get('location')!);
  assert.equal(target.origin + target.pathname, 'https://github.com/apps/versimo/installations/new');
  return target.searchParams.get('state')!;
}

function callback(app: ReturnType<typeof createApp>, session: string, params: Record<string, string>) {
  return app(new Request(`${ORIGIN}/app/github/callback?${new URLSearchParams(params)}`, { headers: { cookie: session } }));
}

function hook(app: ReturnType<typeof createApp>, event: string, payload: unknown, secret = 'hook-secret') {
  const body = JSON.stringify(payload);
  return app(
    new Request(`${ORIGIN}/api/github/webhook`, {
      method: 'POST',
      headers: {
        'x-github-event': event,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
      body,
    }),
  );
}

describe('connect a repo', () => {
  it('installs, checks the installer, connects the only repo and imports modules from tags', async () => {
    const { app, session, project, call } = await setup();
    const state = await installState(app, session, project.id);
    const res = await callback(app, session, { code: 'good-code', installation_id: '42', setup_action: 'install', state });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/app?project=${project.id}&github=connected`);

    const got = await (await call('GET', `/api/projects/${project.id}/github`)).json();
    assert.deepEqual(got, { github: { installationId: 42, repo: 'acme/shop' }, repos: ['acme/shop'] });
    const { modules } = await (await call('GET', `/api/projects/${project.id}`)).json();
    // search only has a release candidate, so it waits for a stable tag.
    assert.deepEqual(modules.map((m: any) => [m.module, m.last, m.current, m.next]), [['billing', '2.3.1', '2.4.0', null]]);
    const { history } = await (await call('GET', `/api/projects/${project.id}/history`)).json();
    assert.deepEqual(history.map((h: any) => [h.action, h.to, h.by]), [['create', '2.4.0', 'Catalin']]);
  });

  it('refuses an installation id the person cannot see', async () => {
    const { app, session, project, store, user } = await setup();
    const state = await installState(app, session, project.id);
    const res = await callback(app, session, { code: 'good-code', installation_id: '777', state });
    assert.equal(res.headers.get('location'), `/app?project=${project.id}&github=denied`);
    assert.equal(await store.getGithub(user.id, project.id), null);
  });

  it('refuses a state from another person or no state at all', async () => {
    const { app, session, project, store, user } = await setup();
    const forged = await sign({ uid: 'someone-else', project: project.id }, base.sessionSecret, 600);
    for (const state of [forged, 'nope', '']) {
      const res = await callback(app, session, { code: 'good-code', installation_id: '42', state });
      assert.equal(res.headers.get('location'), '/app?github=expired');
    }
    assert.equal(await store.getGithub(user.id, project.id), null);
  });

  it('reports a cancelled install', async () => {
    const { app, session, project } = await setup();
    const state = await installState(app, session, project.id);
    const res = await callback(app, session, { state });
    assert.equal(res.headers.get('location'), `/app?project=${project.id}&github=cancelled`);
  });

  it('asks the person to choose when the installation sees several repos, and only allows those', async () => {
    const gh = fakeGitHub({ repos: { 42: ['acme/blog', 'acme/shop'] } });
    const { app, session, project, call } = await setup(config, gh);
    const state = await installState(app, session, project.id);
    const res = await callback(app, session, { code: 'good-code', installation_id: '42', state });
    assert.equal(res.headers.get('location'), `/app?project=${project.id}&github=choose`);
    const got = await (await call('GET', `/api/projects/${project.id}/github`)).json();
    assert.deepEqual(got, { github: { installationId: 42, repo: null }, repos: ['acme/blog', 'acme/shop'] });

    assert.equal((await call('PUT', `/api/projects/${project.id}/github`, { repo: 'other/secret' })).status, 400);
    assert.equal((await call('PUT', `/api/projects/${project.id}/github`, { repo: 'not a repo' })).status, 400);
    const put = await call('PUT', `/api/projects/${project.id}/github`, { repo: 'ACME/shop' });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { github: { installationId: 42, repo: 'acme/shop' }, imported: ['billing'] });
  });

  it('needs an installation before a repo can be picked, and disconnects', async () => {
    const { app, session, project, call, store, user } = await setup();
    assert.equal((await call('PUT', `/api/projects/${project.id}/github`, { repo: 'acme/shop' })).status, 409);
    const state = await installState(app, session, project.id);
    await callback(app, session, { code: 'good-code', installation_id: '42', state });
    assert.equal((await call('DELETE', `/api/projects/${project.id}/github`)).status, 204);
    assert.equal(await store.getGithub(user.id, project.id), null);
  });

  it('keeps GitHub routes behind the session and the app origin', async () => {
    const { app, project } = await setup();
    const anon = await app(new Request(`${ORIGIN}/api/projects/${project.id}/github`));
    assert.equal(anon.status, 401);
  });

  it('answers 503 when the GitHub app is not set up', async () => {
    const { call, project, app } = await setup(base);
    assert.equal((await call('GET', `/api/projects/${project.id}/github/install`)).status, 503);
    assert.equal((await hook(app, 'ping', {})).status, 503);
  });
});

describe('github webhook', () => {
  async function connected() {
    const ctx = await setup();
    await ctx.store.setGithub(ctx.user.id, ctx.project.id, { installationId: 42, repo: 'acme/shop' });
    return ctx;
  }

  it('adds a module when its first stable tag is pushed, once', async () => {
    const { app, call, project } = await connected();
    const payload = { ref: 'search/v1.0.0', ref_type: 'tag', repository: { full_name: 'acme/shop' }, installation: { id: 42 } };
    const res = await hook(app, 'create', payload);
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { module: 'search', version: '1.0.0', projects: 1 });
    assert.deepEqual(await (await hook(app, 'create', payload)).json(), { module: 'search', version: '1.0.0', projects: 0 });
    const { modules } = await (await call('GET', `/api/projects/${project.id}`)).json();
    assert.deepEqual(modules.map((m: any) => [m.module, m.current]), [['search', '1.0.0']]);
    const { history } = await (await call('GET', `/api/projects/${project.id}/history`)).json();
    assert.deepEqual(history.map((h: any) => h.by), ['GitHub']);
  });

  it('ignores other tags, branches, other repos and pre-releases', async () => {
    const { app, call, project } = await connected();
    for (const payload of [
      { ref: 'v1.0.0', ref_type: 'tag', repository: { full_name: 'acme/shop' }, installation: { id: 42 } },
      { ref: 'search/v1.0.0', ref_type: 'branch', repository: { full_name: 'acme/shop' }, installation: { id: 42 } },
      { ref: 'search/v2.0.0-rc.1', ref_type: 'tag', repository: { full_name: 'acme/shop' }, installation: { id: 42 } },
    ]) {
      assert.equal((await hook(app, 'create', payload)).status, 202);
    }
    await hook(app, 'create', { ref: 'search/v1.0.0', ref_type: 'tag', repository: { full_name: 'acme/blog' }, installation: { id: 42 } });
    await hook(app, 'create', { ref: 'search/v1.0.0', ref_type: 'tag', repository: { full_name: 'acme/shop' }, installation: { id: 43 } });
    assert.deepEqual((await (await call('GET', `/api/projects/${project.id}`)).json()).modules, []);
  });

  it('refuses a bad signature and needs no session or origin', async () => {
    const { app } = await connected();
    assert.equal((await hook(app, 'create', {}, 'wrong')).status, 401);
    assert.equal((await hook(app, 'ping', { zen: 'hi' })).status, 202);
  });

  it('disconnects projects when the app is uninstalled', async () => {
    const { app, store, user, project } = await connected();
    const res = await hook(app, 'installation', { action: 'deleted', installation: { id: 42 } });
    assert.deepEqual(await res.json(), { cleared: 1 });
    assert.equal(await store.getGithub(user.id, project.id), null);
  });
});
