import { resolve } from './resolve.js';
import { validateRecord } from './validate.js';
import { VersimoError, type Context, type ModuleRecord, type Resolution } from './types.js';
import type { RolloutFn } from './posthog.js';

export type SourceFn = (module: string) => ModuleRecord | null | undefined | Promise<ModuleRecord | null | undefined>;

export interface ClientOptions {
  /**
   * A function returning the record for a module, or a URL.
   * A URL containing `{module}` has it replaced. Any other URL is a base
   * and the client fetches `<base>/<module>.json`.
   */
  source: SourceFn | string;
  /** How long a record is cached, in milliseconds. Default 30000. */
  ttlMs?: number;
  /** Clock for the cache, in milliseconds. Mainly for tests. */
  now?: () => number;
  /** Fetch implementation for URL sources. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Overrides the record's `rollout`, for example `postHogRollout(...)`.
   * Only the share changes. Who lands on `next` is still decided by `bucketFor`.
   * When it returns null or fails, the record's own rollout is used.
   */
  rollout?: RolloutFn;
}

export interface VersimoClient {
  record(module: string): Promise<ModuleRecord>;
  resolve(module: string, ctx?: Context): Promise<Resolution>;
  version(module: string, ctx?: Context): Promise<string>;
  /** Drops one cached record, or all of them. */
  clear(module?: string): void;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function urlSource(url: string, fetchImpl: typeof fetch | undefined): SourceFn {
  return async (module) => {
    const f = fetchImpl ?? globalThis.fetch;
    if (!f) throw new VersimoError('SOURCE_ERROR', 'No fetch available. Pass the `fetch` option.');
    const target = url.includes('{module}')
      ? url.replace('{module}', module)
      : `${url.replace(/\/+$/, '')}/${module}.json`;
    let res: Response;
    try {
      res = await f(target);
    } catch (err) {
      throw new VersimoError('SOURCE_ERROR', `Could not fetch ${target}: ${(err as Error).message}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new VersimoError('SOURCE_ERROR', `Fetching ${target} returned ${res.status}`);
    return (await res.json()) as ModuleRecord;
  };
}

export function createClient(options: ClientOptions): VersimoClient {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const source = typeof options.source === 'string' ? urlSource(options.source, options.fetch) : options.source;
  const cache = new Map<string, { record: ModuleRecord; expires: number }>();
  const inflight = new Map<string, Promise<ModuleRecord>>();

  async function load(module: string): Promise<ModuleRecord> {
    const raw = await source(module);
    if (raw === null || raw === undefined) throw new VersimoError('NOT_FOUND', `No record for module "${module}"`);
    const checked = validateRecord(raw);
    if (!checked.ok) {
      throw new VersimoError('INVALID_RECORD', `Invalid record for "${module}": ${checked.errors.join('; ')}`);
    }
    return raw;
  }

  async function withRollout(rec: ModuleRecord): Promise<ModuleRecord> {
    if (!options.rollout) return rec;
    let share: number | null | undefined;
    try {
      share = await options.rollout(rec.module);
    } catch {
      return rec;
    }
    if (typeof share !== 'number' || !Number.isInteger(share) || share < 0 || share > 100) return rec;
    return share === rec.rollout ? rec : { ...rec, rollout: share };
  }

  async function record(module: string): Promise<ModuleRecord> {
    return withRollout(await stored(module));
  }

  async function stored(module: string): Promise<ModuleRecord> {
    if (!SLUG.test(module)) throw new VersimoError('INVALID_INPUT', `Invalid module slug: ${JSON.stringify(module)}`);
    const hit = cache.get(module);
    if (hit && hit.expires > now()) return hit.record;
    const pending = inflight.get(module);
    if (pending) return pending;
    const p = load(module)
      .then((rec) => {
        cache.set(module, { record: rec, expires: now() + ttlMs });
        return rec;
      })
      .catch((err) => {
        const e = err instanceof VersimoError ? err : new VersimoError('SOURCE_ERROR', (err as Error).message);
        // Serve the stale record when the source is down. A missing or invalid record is not hidden.
        if (hit && e.code === 'SOURCE_ERROR') {
          cache.set(module, { record: hit.record, expires: now() + ttlMs });
          return hit.record;
        }
        throw e;
      })
      .finally(() => inflight.delete(module));
    inflight.set(module, p);
    return p;
  }

  return {
    record,
    async resolve(module, ctx) {
      return resolve(await record(module), ctx);
    },
    async version(module, ctx) {
      return (await this.resolve(module, ctx)).version;
    },
    clear(module) {
      if (module === undefined) cache.clear();
      else cache.delete(module);
    },
  };
}
