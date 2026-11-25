import { bucketFor } from './bucket.js';
import type { Context, ModuleRecord, Resolution } from './types.js';

/** Like `resolveVersion`, but says which channel was chosen and why. */
export function resolve(record: ModuleRecord, ctx: Context = {}): Resolution {
  if (!record.healthy) {
    if (record.last !== null) {
      return { version: record.last, channel: 'last', reason: 'UNHEALTHY', bucket: null };
    }
    return { version: record.current, channel: 'current', reason: 'UNHEALTHY', bucket: null };
  }
  if (!ctx.userId) {
    return { version: record.current, channel: 'current', reason: 'NO_USER', bucket: null };
  }
  const bucket = bucketFor(record.module, ctx.userId);
  if (record.next !== null && bucket < record.rollout) {
    return { version: record.next, channel: 'next', reason: 'ROLLOUT', bucket };
  }
  return { version: record.current, channel: 'current', reason: 'DEFAULT', bucket };
}

/** The version of the module this user should get. */
export function resolveVersion(record: ModuleRecord, ctx: Context = {}): string {
  return resolve(record, ctx).version;
}
