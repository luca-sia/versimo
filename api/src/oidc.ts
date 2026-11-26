/** The sign in issuer: its discovery document, its signing keys and the ID token checks. Web Crypto only. */

import { fromB64url } from './session.js';

const TTL = 3600 * 1000;
const SKEW = 60;

export interface Endpoints {
  authorize: string;
  token: string;
  userinfo: string;
  jwks: string;
}

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
}

/** A JSON number can parse to infinity, which is not a time. */
const isTime = (value: unknown): value is number => Number.isFinite(value);

export interface Oidc {
  endpoints(): Promise<Endpoints>;
  /** The subject of an ID token that passes every check. Throws a short reason otherwise. */
  subject(idToken: unknown, expected: { clientId: string; nonce: string }): Promise<string>;
}

function decode(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(fromB64url(part)));
  if (typeof value !== 'object' || value === null) throw new Error('id-token-shape');
  return value as Record<string, unknown>;
}

/** Keeps what it fetched for an hour, so make one per process and reuse it. */
export function createOidc(issuer: string, doFetch: typeof fetch): Oidc {
  let discovered: { value: Endpoints; until: number } | null = null;
  let published: { value: Jwk[]; until: number } | null = null;

  async function get(url: string, what: string): Promise<Record<string, unknown>> {
    const res = await doFetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${what}-${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async function endpoints(): Promise<Endpoints> {
    if (discovered && discovered.until > Date.now()) return discovered.value;
    const doc = await get(`${issuer}/.well-known/openid-configuration`, 'discovery');
    if (doc.issuer !== issuer) throw new Error('discovery-issuer');
    const url = (key: string) => {
      const value = doc[key];
      if (typeof value !== 'string' || !value.startsWith('https://')) throw new Error(`discovery-${key}`);
      return value;
    };
    const value = {
      authorize: url('authorization_endpoint'),
      token: url('token_endpoint'),
      userinfo: url('userinfo_endpoint'),
      jwks: url('jwks_uri'),
    };
    discovered = { value, until: Date.now() + TTL };
    return value;
  }

  /** A key id that is not in the cached set fetches the set again, so a rotated key works at once. */
  async function signingKey(kid: unknown): Promise<Jwk> {
    const find = (keys: Jwk[]) =>
      keys.find(
        (k) =>
          k.kid === kid &&
          k.kty === 'RSA' &&
          (k.alg ?? 'RS256') === 'RS256' &&
          (k.use ?? 'sig') === 'sig' &&
          (k.key_ops?.includes('verify') ?? true),
      );
    const cached = published && published.until > Date.now() ? find(published.value) : undefined;
    if (cached) return cached;
    const body = await get((await endpoints()).jwks, 'jwks');
    published = { value: Array.isArray(body.keys) ? (body.keys as Jwk[]) : [], until: Date.now() + TTL };
    const key = find(published.value);
    if (!key) throw new Error('id-token-key');
    return key;
  }

  async function subject(idToken: unknown, expected: { clientId: string; nonce: string }): Promise<string> {
    if (typeof idToken !== 'string') throw new Error('id-token-missing');
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('id-token-shape');
    const [head, body, signature] = parts as [string, string, string];
    const header = decode(head);
    if (header.alg !== 'RS256') throw new Error('id-token-alg');
    // No header extension is supported, so none may be marked critical.
    if (header.crit !== undefined) throw new Error('id-token-crit');
    const { n, e } = await signingKey(header.kid);
    const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n, e }, algorithm, false, ['verify']);
    const signed = new TextEncoder().encode(`${head}.${body}`);
    if (!(await crypto.subtle.verify(algorithm, key, fromB64url(signature), signed))) {
      throw new Error('id-token-signature');
    }
    const claims = decode(body);
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== issuer) throw new Error('id-token-issuer');
    if (claims.aud !== expected.clientId) throw new Error('id-token-audience');
    if (!isTime(claims.exp) || claims.exp < now - SKEW) throw new Error('id-token-expired');
    if (!isTime(claims.iat) || claims.iat > now + SKEW) throw new Error('id-token-future');
    if (claims.nbf !== undefined && (!isTime(claims.nbf) || claims.nbf > now + SKEW)) {
      throw new Error('id-token-not-yet-valid');
    }
    if (claims.nonce !== expected.nonce) throw new Error('id-token-nonce');
    if (typeof claims.sub !== 'string' || claims.sub === '') throw new Error('id-token-subject');
    return claims.sub;
  }

  return { endpoints, subject };
}
