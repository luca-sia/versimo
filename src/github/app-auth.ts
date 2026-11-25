const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | out.length, ...out];
}

function der(tag: number, body: Uint8Array): Uint8Array {
  const len = derLength(body.length);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// AlgorithmIdentifier for rsaEncryption (1.2.840.113549.1.1.1) with NULL parameters.
const RSA_ALGORITHM = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

/** Wraps a PKCS#1 RSA key, as GitHub hands it out, in PKCS#8, which WebCrypto needs. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  return der(0x30, concat(new Uint8Array([0x02, 0x01, 0x00]), RSA_ALGORITHM, der(0x04, pkcs1)));
}

function pemBody(pem: string): { der: Uint8Array; pkcs1: boolean } {
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(pem);
  if (!m) throw new TypeError('privateKey must be a PEM RSA private key');
  const bin = atob(m[2]!.replace(/\s+/g, ''));
  return { der: Uint8Array.from(bin, (c) => c.charCodeAt(0)), pkcs1: Boolean(m[1]) };
}

export interface AppJwtOptions {
  /** The GitHub App id (or its client id). */
  appId: string | number;
  /** The app's private key in PEM form. PKCS#1 and PKCS#8 both work. */
  privateKey: string;
  /** Clock, mainly for tests. Defaults to now. */
  now?: Date | string | number;
}

/**
 * Signs the short lived JWT a GitHub App uses to ask for installation tokens.
 * It is valid for nine minutes and backdated by one, as GitHub advises.
 * Works anywhere WebCrypto does: Node 20, Cloudflare Workers and browsers.
 */
export async function createAppJwt({ appId, privateKey, now = new Date() }: AppJwtOptions): Promise<string> {
  const { der: body, pkcs1 } = pemBody(privateKey);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    new Uint8Array(pkcs1 ? pkcs1ToPkcs8(body) : body),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const iat = Math.floor(new Date(now).getTime() / 1000) - 60;
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(encoder.encode(JSON.stringify({ iat, exp: iat + 600, iss: String(appId) })));
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}
