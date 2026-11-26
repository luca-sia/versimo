import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import worker, { type Env } from '../src/worker.js';

describe('worker', () => {
  it('follows a changed issuer in the same isolate', async () => {
    mock.method(globalThis, 'fetch', async (input: string) => {
      const issuer = input.replace('/.well-known/openid-configuration', '');
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
      });
    });
    const env = (issuer: string): Env => ({
      HYPERDRIVE: { connectionString: 'postgres://nobody@127.0.0.1:1/none' },
      ISSUER: issuer,
      CLIENT_ID: 'versimo',
      APP_ORIGIN: 'https://versimo.test',
      CLIENT_SECRET: 'client-secret',
      SESSION_SECRET: 'a-session-secret-that-is-long-enough-1234',
    });
    for (const issuer of ['https://one.example', 'https://two.example']) {
      const res = await worker.fetch(new Request('https://versimo.test/api/auth/login'), env(issuer), {
        waitUntil: () => {},
      });
      assert.match(res.headers.get('location')!, new RegExp(`^${issuer}/authorize\\?`));
    }
    mock.restoreAll();
  });
});
