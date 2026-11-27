/** Seals short secrets, such as a PostHog key, with AES-GCM. Web Crypto only, so it runs in Workers and Node. */

import { b64url, fromB64url } from './session.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A separate AES key for each purpose, derived from SESSION_SECRET with HKDF. */
async function aesKey(secret: string, purpose: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('versimo'), info: enc.encode(purpose) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** `v1.<iv>.<ciphertext>`, both base64url. */
export async function seal(text: string, secret: string, purpose: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret, purpose), enc.encode(text));
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(out))}`;
}

/** The text, or null when the value was not sealed with this secret and purpose. */
export async function unseal(sealed: string, secret: string, purpose: string): Promise<string | null> {
  const [version, iv, data] = sealed.split('.');
  if (version !== 'v1' || !iv || !data) return null;
  try {
    const out = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64url(iv) },
      await aesKey(secret, purpose),
      fromB64url(data),
    );
    return dec.decode(out);
  } catch {
    return null;
  }
}
