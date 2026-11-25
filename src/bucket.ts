const encoder = new TextEncoder();

/**
 * Maps a module and user to a stable bucket from 0 to 99.
 * FNV-1a over the UTF-8 bytes of `module`, a NUL byte and `userId`,
 * then the murmur3 32-bit finaliser, then modulo 100.
 * The steps are simple on purpose so other languages can port them.
 */
export function bucketFor(module: string, userId: string): number {
  const bytes = encoder.encode(`${module}\u0000${userId}`);
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
