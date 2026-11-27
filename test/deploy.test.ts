import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeployClient, VersimoError } from '../src/index.js';

function fake(status = 200, body: unknown = { module: { module: 'app', current: '1.0.1' } }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test('sends each change to the deploy routes with the bearer key', async () => {
  const { calls, fetchImpl } = fake();
  const v = createDeployClient({ key: 'vdk_x', base: 'https://versimo.test/', fetch: fetchImpl });
  await v.create('app', '1.0.0', '0.9.0');
  await v.draft('app', '1.0.1', { patch: true });
  await v.rollout('app', 25);
  await v.promote('app');
  await v.rollback('app');
  assert.deepEqual(
    calls.map((c) => [c.init.method, c.url, c.init.body]),
    [
      ['POST', 'https://versimo.test/api/deploy/modules', '{"module":"app","current":"1.0.0","last":"0.9.0"}'],
      ['POST', 'https://versimo.test/api/deploy/modules/app/draft', '{"version":"1.0.1","patch":true}'],
      ['POST', 'https://versimo.test/api/deploy/modules/app/rollout', '{"rollout":25}'],
      ['POST', 'https://versimo.test/api/deploy/modules/app/promote', '{}'],
      ['POST', 'https://versimo.test/api/deploy/modules/app/rollback', '{}'],
    ],
  );
  assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), 'Bearer vdk_x');
});

test('lists modules with a GET and no body', async () => {
  const { calls, fetchImpl } = fake(200, { modules: [{ module: 'app' }] });
  const v = createDeployClient({ key: 'vdk_x', fetch: fetchImpl });
  assert.deepEqual(await v.list(), [{ module: 'app' }]);
  assert.equal(calls[0]!.url, 'https://versimo.dev/api/deploy/modules');
  assert.equal(calls[0]!.init.body, undefined);
});

test('turns a refusal into a VersimoError with the API reason', async () => {
  const { fetchImpl } = fake(400, { error: 'Nothing to promote: next is empty' });
  const v = createDeployClient({ key: 'vdk_x', fetch: fetchImpl });
  await assert.rejects(v.promote('app'), (e: unknown) => e instanceof VersimoError && /next is empty/.test(e.message));
});
