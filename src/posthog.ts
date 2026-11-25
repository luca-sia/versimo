import { VersimoError } from './types.js';

/**
 * A function returning the share of users on `next` for a module, from 0 to 100.
 * Null or undefined means "no override": the record's own `rollout` is used.
 */
export type RolloutFn = (module: string) => number | null | undefined | Promise<number | null | undefined>;

export interface PostHogRolloutOptions {
  /** The PostHog project API key (starts with `phc_`). It is a public key. */
  apiKey: string;
  /** PostHog ingestion host. Default `https://eu.i.posthog.com`. Use `https://us.i.posthog.com` for US projects. */
  host?: string;
  /** How long one PostHog answer is cached, in milliseconds. Default 30000. */
  ttlMs?: number;
  /** Clock for the cache, in milliseconds. Mainly for tests. */
  now?: () => number;
  /** Fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** The PostHog flag that carries the share for a module. */
export function postHogFlagKey(module: string): string {
  return `versimo-${module}`;
}

/** The fixed distinct id sent to PostHog. No user id ever leaves the app. */
export const POSTHOG_DISTINCT_ID = 'versimo';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Reads the share on `next` from one flag in a PostHog `/flags?v=2` answer.
 *
 * - No flag: null, so the record's own rollout is used.
 * - Flag off: 0. Turning the flag off takes everyone off `next`.
 * - Flag on with a payload `{"rollout": n}`, n an integer from 0 to 100: n.
 * - Anything else: null.
 *
 * The payload may be a JSON string, as PostHog sends it, or an object.
 * Who lands on `next` is still decided by `bucketFor`, never by PostHog.
 */
export function rolloutFromFlag(flag: unknown): number | null {
  if (!isObject(flag)) return null;
  if (flag.enabled === false) return 0;
  if (flag.enabled !== true) return null;
  let payload = isObject(flag.metadata) ? flag.metadata.payload : undefined;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!isObject(payload)) return null;
  const n = payload.rollout;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
}

/**
 * A rollout source backed by PostHog feature flags, for `createClient({ rollout })`.
 *
 * One request to `<host>/flags?v=2` is made per TTL for all modules. The request
 * carries only the project key and the fixed distinct id `versimo`, so no user id
 * or other user data is sent. When PostHog cannot be reached the last good answer
 * is kept, and with none the record's own rollout is used.
 */
export function postHogRollout(options: PostHogRolloutOptions): RolloutFn {
  if (!options.apiKey) throw new VersimoError('INVALID_INPUT', 'postHogRollout needs an apiKey');
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const url = `${(options.host ?? 'https://eu.i.posthog.com').replace(/\/+$/, '')}/flags?v=2`;
  let cached: { flags: Record<string, unknown>; expires: number } | undefined;
  let inflight: Promise<Record<string, unknown> | undefined> | undefined;

  async function load(): Promise<Record<string, unknown>> {
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new VersimoError('SOURCE_ERROR', 'No fetch available. Pass the `fetch` option.');
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: options.apiKey, distinct_id: POSTHOG_DISTINCT_ID }),
    });
    if (!res.ok) throw new VersimoError('SOURCE_ERROR', `PostHog returned ${res.status}`);
    const body: unknown = await res.json();
    if (!isObject(body) || !isObject(body.flags)) throw new VersimoError('SOURCE_ERROR', 'PostHog answer has no flags');
    return body.flags;
  }

  async function flags(): Promise<Record<string, unknown> | undefined> {
    if (cached && cached.expires > now()) return cached.flags;
    inflight ??= load()
      .then((fresh) => {
        cached = { flags: fresh, expires: now() + ttlMs };
        return fresh;
      })
      .catch(() => {
        // Keep the last good answer for another TTL. With none, use the record.
        if (cached) cached = { flags: cached.flags, expires: now() + ttlMs };
        return cached?.flags;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  return async (module) => {
    const all = await flags();
    return all ? rolloutFromFlag(all[postHogFlagKey(module)]) : null;
  };
}
