import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketFor, utf8Bytes } from '../src/bucket.js';

const SAMPLES = ['', 'user-42', 'é', '😀', '日本語', 'a\u0000b', 'x'.repeat(300), '\u{10FFFF}', 'lone \ud800 high', 'lone \udc00 low'];

async function withoutTextEncoder<T>(run: () => T | Promise<T>): Promise<T> {
  const saved = globalThis.TextEncoder;
  // @ts-expect-error simulate an engine without TextEncoder
  globalThis.TextEncoder = undefined;
  try {
    return await run();
  } finally {
    globalThis.TextEncoder = saved;
  }
}

test('the fallback encoder matches TextEncoder', async () => {
  for (const s of SAMPLES) {
    const expected = new TextEncoder().encode(s);
    const actual = await withoutTextEncoder(() => utf8Bytes(s));
    assert.deepEqual(Array.from(actual), Array.from(expected), JSON.stringify(s));
  }
});

test('bucketFor gives the same bucket without TextEncoder', async () => {
  for (const s of SAMPLES) {
    const expected = bucketFor('billing', s);
    assert.equal(await withoutTextEncoder(() => bucketFor('billing', s)), expected, JSON.stringify(s));
  }
});
