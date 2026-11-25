const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Checks the `X-Hub-Signature-256` header of a GitHub webhook.
 * Pass the raw body exactly as it arrived. Never throws.
 */
export async function verifyWebhookSignature(
  secret: string,
  body: string | Uint8Array,
  signature: string | null | undefined,
): Promise<boolean> {
  if (!secret || typeof signature !== 'string' || !signature.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const data = typeof body === 'string' ? encoder.encode(body) : new Uint8Array(body);
  const expected = `sha256=${toHex(await crypto.subtle.sign('HMAC', key, data))}`;
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
