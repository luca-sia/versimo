import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub, getInstallationToken } from '../src/github/index.js';
import { VersimoError } from '../src/index.js';

interface Call {
  method: string;
  url: string;
  body: any;
  auth: string | null;
}

function fakeGitHub(routes: Record<string, (body: any) => [number, unknown]>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const headers = init.headers as Record<string, string>;
    calls.push({ method, url, body, auth: headers.Authorization ?? null });
    const path = url.replace('https://api.github.com', '');
    const route = routes[`${method} ${path}`];
    if (!route) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const [status, data] = route(body);
    return new Response(JSON.stringify(data), { status });
  }) as unknown as typeof fetch;
  return { calls, fetch: f };
}

const REPO = '/repos/acme/shop';

function prRoutes(extra: Record<string, (body: any) => [number, unknown]> = {}) {
  return {
    [`GET ${REPO}`]: () => [200, { default_branch: 'main' }] as [number, unknown],
    [`GET ${REPO}/git/ref/heads/main`]: () => [200, { object: { sha: 'base-sha' } }] as [number, unknown],
    [`GET ${REPO}/git/commits/base-sha`]: () => [200, { tree: { sha: 'base-tree' } }] as [number, unknown],
    [`POST ${REPO}/git/trees`]: () => [201, { sha: 'new-tree' }] as [number, unknown],
    [`POST ${REPO}/git/commits`]: () => [201, { sha: 'new-commit' }] as [number, unknown],
    [`POST ${REPO}/git/refs`]: () => [201, {}] as [number, unknown],
    [`POST ${REPO}/pulls`]: () => [201, { number: 7, html_url: 'https://github.com/acme/shop/pull/7', node_id: 'PR_7' }] as [number, unknown],
    ['POST /graphql']: () => [200, { data: { enablePullRequestAutoMerge: { clientMutationId: null } } }] as [number, unknown],
    ...extra,
  };
}

const input = {
  owner: 'acme',
  repo: 'shop',
  head: 'versimo/billing-v2.4.1',
  title: 'billing 2.4.1',
  files: [{ path: 'versimo/billing.json', content: '{}\n' }],
};

test('listTags pages through every tag', async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ name: `billing/v1.0.${i}` }));
  const gh = fakeGitHub({
    [`GET ${REPO}/tags?per_page=100&page=1`]: () => [200, first],
    [`GET ${REPO}/tags?per_page=100&page=2`]: () => [200, [{ name: 'search/v1.0.0' }, { name: 'v0.1.0' }]],
  });
  const tags = await createGitHub({ token: 't', fetch: gh.fetch }).listTags('acme', 'shop');
  assert.equal(tags.length, 102);
  assert.equal(gh.calls[0]!.auth, 'Bearer t');
});

test('moduleVersions reads module tags only', async () => {
  const gh = fakeGitHub({
    [`GET ${REPO}/tags?per_page=100&page=1`]: () => [200, [{ name: 'billing/v2.4.0' }, { name: 'billing/v2.3.1' }, { name: 'v1.0.0' }]],
  });
  assert.deepEqual(await createGitHub({ token: 't', fetch: gh.fetch }).moduleVersions('acme', 'shop'), {
    billing: ['2.4.0', '2.3.1'],
  });
});

test('openPullRequest commits to a new branch, opens the PR and turns on auto merge', async () => {
  const gh = fakeGitHub(prRoutes());
  const result = await createGitHub({ token: 't', fetch: gh.fetch }).openPullRequest(input);
  assert.deepEqual(result, {
    number: 7,
    url: 'https://github.com/acme/shop/pull/7',
    head: 'versimo/billing-v2.4.1',
    base: 'main',
    autoMerge: true,
  });
  const byRoute = (m: string, p: string) => gh.calls.find((c) => c.method === m && c.url.endsWith(p))!;
  assert.deepEqual(byRoute('POST', '/git/trees').body, {
    base_tree: 'base-tree',
    tree: [{ path: 'versimo/billing.json', mode: '100644', type: 'blob', content: '{}\n' }],
  });
  assert.deepEqual(byRoute('POST', '/git/commits').body, { message: 'billing 2.4.1', tree: 'new-tree', parents: ['base-sha'] });
  assert.deepEqual(byRoute('POST', '/git/refs').body, { ref: 'refs/heads/versimo/billing-v2.4.1', sha: 'new-commit' });
  assert.deepEqual(byRoute('POST', '/pulls').body, { title: 'billing 2.4.1', head: 'versimo/billing-v2.4.1', base: 'main', body: '' });
  assert.deepEqual(byRoute('POST', '/graphql').body.variables, { id: 'PR_7', method: 'SQUASH' });
});

test('openPullRequest never moves an existing branch', async () => {
  const gh = fakeGitHub(prRoutes());
  await createGitHub({ token: 't', fetch: gh.fetch }).openPullRequest(input);
  assert.equal(gh.calls.some((c) => c.method === 'PATCH' || c.method === 'PUT' || c.method === 'DELETE'), false);
});

test('openPullRequest refuses to write to main, the default branch or the base', async () => {
  for (const [head, extra] of [
    ['main', {}],
    ['master', {}],
    ['trunk', { [`GET ${REPO}`]: () => [200, { default_branch: 'trunk' }] }],
    ['release', { base: 'release' }],
  ] as const) {
    const gh = fakeGitHub(prRoutes('base' in extra ? {} : (extra as any)));
    const client = createGitHub({ token: 't', fetch: gh.fetch });
    await assert.rejects(
      client.openPullRequest({ ...input, head, ...('base' in extra ? extra : {}) }),
      (err: unknown) => err instanceof VersimoError && err.code === 'INVALID_INPUT',
      head,
    );
    assert.equal(gh.calls.filter((c) => c.method !== 'GET').length, 0, head);
  }
});

test('openPullRequest checks its input before calling GitHub', async () => {
  const gh = fakeGitHub(prRoutes());
  const client = createGitHub({ token: 't', fetch: gh.fetch });
  for (const bad of [{ head: 'a..b' }, { head: '/x' }, { head: 'x.lock' }, { head: 'has space' }, { files: [] }, { title: '' }]) {
    await assert.rejects(client.openPullRequest({ ...input, ...bad }), VersimoError, JSON.stringify(bad));
  }
  assert.equal(gh.calls.length, 0);
});

test('openPullRequest fails when the branch already exists', async () => {
  const gh = fakeGitHub(prRoutes({ [`POST ${REPO}/git/refs`]: () => [422, { message: 'Reference already exists' }] }));
  await assert.rejects(
    createGitHub({ token: 't', fetch: gh.fetch }).openPullRequest(input),
    /422 Reference already exists/,
  );
  assert.equal(gh.calls.some((c) => c.url.endsWith('/pulls')), false);
});

test('openPullRequest still returns the PR when auto merge is not allowed', async () => {
  const gh = fakeGitHub(
    prRoutes({ ['POST /graphql']: () => [200, { errors: [{ message: 'Auto merge is not allowed for this repository' }] }] }),
  );
  const result = await createGitHub({ token: 't', fetch: gh.fetch }).openPullRequest(input);
  assert.equal(result.number, 7);
  assert.equal(result.autoMerge, false);
  assert.equal(result.autoMergeError, 'Auto merge is not allowed for this repository');
});

test('openPullRequest can leave auto merge off', async () => {
  const gh = fakeGitHub(prRoutes());
  const result = await createGitHub({ token: 't', fetch: gh.fetch }).openPullRequest({ ...input, autoMerge: false });
  assert.equal(result.autoMerge, false);
  assert.equal(gh.calls.some((c) => c.url.endsWith('/graphql')), false);
});

test('errors carry the GitHub status and a Versimo code', async () => {
  const gh = fakeGitHub({ [`GET ${REPO}/tags?per_page=100&page=1`]: () => [403, { message: 'Resource not accessible by integration' }] });
  await assert.rejects(
    createGitHub({ token: 't', fetch: gh.fetch }).listTags('acme', 'shop'),
    (err: unknown) => err instanceof VersimoError && err.code === 'SOURCE_ERROR' && /403/.test(err.message),
  );
  await assert.rejects(
    createGitHub({ token: 't', fetch: gh.fetch }).listTags('acme', 'missing'),
    (err: unknown) => err instanceof VersimoError && err.code === 'NOT_FOUND',
  );
});

test('a non JSON answer still gives a VersimoError', async () => {
  const f = (async () => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' })) as unknown as typeof fetch;
  await assert.rejects(
    createGitHub({ token: 't', fetch: f }).listTags('acme', 'shop'),
    (err: unknown) => err instanceof VersimoError && err.code === 'SOURCE_ERROR' && /502 Bad Gateway/.test(err.message),
  );
});

test('createGitHub needs a token', () => {
  assert.throws(() => createGitHub({ token: '' }), VersimoError);
});

test('getInstallationToken swaps the app JWT for a token', async () => {
  const gh = fakeGitHub({
    ['POST /app/installations/99/access_tokens']: () => [201, { token: 'ghs_x', expires_at: '2026-11-26T00:00:00Z' }],
  });
  assert.deepEqual(await getInstallationToken({ jwt: 'jwt', installationId: 99, fetch: gh.fetch }), {
    token: 'ghs_x',
    expiresAt: '2026-11-26T00:00:00Z',
  });
  assert.equal(gh.calls[0]!.auth, 'Bearer jwt');
});
