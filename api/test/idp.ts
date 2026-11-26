/** A fake issuer for the tests: discovery, keys, and a token endpoint that signs real RS256 ID tokens. */

import { b64url } from '../src/session.js';

export const ISSUER = 'https://accounts.example/api/auth';
const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

export const newKey = () =>
  crypto.subtle.generateKey(
    { ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  );

const part = (value: object) => b64url(new TextEncoder().encode(JSON.stringify(value)));

export interface Tamper {
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  /** Signs with this key instead of the published one. */
  signWith?: CryptoKey;
  discovery?: Record<string, unknown>;
  userinfo?: Record<string, unknown>;
  idToken?: null;
}

export interface FakeIdp {
  fetch: typeof fetch;
  calls: { url: string; body?: string; auth?: string | null }[];
  /** Publishes a new signing key under a new key id. */
  rotate(): Promise<void>;
}

/** The code the fake accepts. It carries the nonce, as the issuer's stored code would. */
export const goodCode = (nonce: string) => `good-code.${nonce}`;

export function fakeIdp(sub = 'user-catalin', name = 'Catalin', tamper: Tamper = {}): FakeIdp {
  const calls: FakeIdp['calls'] = [];
  let current: Promise<CryptoKeyPair> | undefined;
  let kid = 1;
  const keys = () => (current ??= newKey());
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, body: init?.body ? String(init.body) : undefined, auth: headers.get('authorization') });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth2/authorize`,
        token_endpoint: `${ISSUER}/oauth2/token`,
        userinfo_endpoint: `${ISSUER}/oauth2/userinfo`,
        jwks_uri: `${ISSUER}/jwks`,
        ...tamper.discovery,
      });
    }
    if (url === `${ISSUER}/jwks`) {
      const jwk = await crypto.subtle.exportKey('jwk', (await keys()).publicKey);
      return Response.json({ keys: [{ ...jwk, kid: `key-${kid}` }] });
    }
    if (url === `${ISSUER}/oauth2/token`) {
      const [code, nonce] = (new URLSearchParams(String(init?.body)).get('code') ?? '').split('.');
      if (code !== 'good-code') return new Response('{"error":"invalid_grant"}', { status: 400 });
      const now = Math.floor(Date.now() / 1000);
      const head = part({ alg: 'RS256', kid: `key-${kid}`, ...tamper.header });
      const body = part({ iss: ISSUER, aud: 'versimo', sub, nonce, iat: now, exp: now + 600, ...tamper.claims });
      const signature = await crypto.subtle.sign(
        RSA,
        tamper.signWith ?? (await keys()).privateKey,
        new TextEncoder().encode(`${head}.${body}`),
      );
      return Response.json({
        access_token: `token-for-${sub}`,
        token_type: 'Bearer',
        id_token: tamper.idToken === null ? undefined : `${head}.${body}.${b64url(new Uint8Array(signature))}`,
      });
    }
    if (url === `${ISSUER}/oauth2/userinfo`) {
      if (headers.get('authorization') !== `Bearer token-for-${sub}`) return new Response('', { status: 401 });
      return Response.json({ sub, name, email: `${sub}@example.com`, email_verified: true, ...tamper.userinfo });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return {
    fetch: f,
    calls,
    async rotate() {
      kid += 1;
      current = newKey();
      await current;
    },
  };
}
