let encoder: TextEncoder | undefined;

/**
 * UTF-8 bytes of a string. Uses `TextEncoder` when the runtime has it.
 * Older React Native engines do not, so there is a small fallback.
 * A lone surrogate becomes U+FFFD, as `TextEncoder` does.
 */
export function utf8Bytes(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return (encoder ??= new TextEncoder()).encode(text);
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

/**
 * Maps a module and user to a stable bucket from 0 to 99.
 * FNV-1a over the UTF-8 bytes of `module`, a NUL byte and `userId`,
 * then the murmur3 32-bit finaliser, then modulo 100.
 * The steps are simple on purpose so other languages can port them.
 */
export function bucketFor(module: string, userId: string): number {
  const bytes = utf8Bytes(`${module}\u0000${userId}`);
  let h = 0x811c9dc5;
  for (const byte of bytes) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) % 100;
}
