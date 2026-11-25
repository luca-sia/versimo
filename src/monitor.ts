import { checkHealth, type HealthChecks, type HealthFailure, type HealthObservation, type HealthResult } from './health.js';
import { validateRecord } from './validate.js';
import { VersimoError, type ModuleRecord } from './types.js';

/** Where the monitor reads and writes module records. */
export interface RecordStore {
  read(module: string): ModuleRecord | null | undefined | Promise<ModuleRecord | null | undefined>;
  write(record: ModuleRecord): void | Promise<void>;
}

/**
 * PostHog error tracking. Tag your events with the module and the version the
 * user got. The error rate is `$exception` events over all events for that
 * module and version in the window.
 */
export interface PostHogOptions {
  /** Default `https://us.posthog.com`. Use `https://eu.posthog.com` for the EU cloud. */
  host?: string;
  projectId: string | number;
  /** A personal API key with query read access. Keep it in your secret store. */
  apiKey: string;
  /** How far back to look, in minutes. Default 5. */
  windowMinutes?: number;
  /** Event property with the module slug. Default `versimo_module`. */
  moduleProperty?: string;
  /** Event property with the version. Default `versimo_version`. */
  versionProperty?: string;
}

export interface HealthAlert {
  module: string;
  /** ISO 8601 date-time of the check. */
  at: string;
  /** The version that failed. */
  version: string;
  rolledBack: boolean;
  /** The version users are on now. */
  current: string;
  failures: HealthFailure[];
  /** One line for people, also used as the Slack `text`. */
  text: string;
}

export interface MonitorOptions {
  store: RecordStore;
  /** Checks by module slug, or a function that returns them. */
  checks: Record<string, HealthChecks> | ((module: string) => HealthChecks | undefined);
  /** Your own measurements. Values here win over PostHog and the URL check. */
  observe?: (module: string, record: ModuleRecord) => HealthObservation | Promise<HealthObservation>;
  posthog?: PostHogOptions;
  /** A webhook URL that gets the alert as JSON (Slack works), or a function. */
  alert?: string | ((alert: HealthAlert) => void | Promise<void>);
  /** Recorded as `by` in history. Default `versimo-health`. */
  by?: string;
  /** Time out for the check URL, in milliseconds. Default 5000. */
  urlTimeoutMs?: number;
  /** Called when a scheduled check throws. Default `console.warn`. */
  onError?: (module: string, error: unknown) => void;
  fetch?: typeof fetch;
  now?: () => Date | number;
}

export interface HealthReport extends HealthResult {
  module: string;
  observation: HealthObservation;
}

export interface HealthMonitor {
  /** Runs the checks for one module once. Rolls back, writes and alerts when current fails. */
  check(module: string): Promise<HealthReport>;
  /** Checks every module on a timer. Returns a function that stops it. */
  start(modules: string[], everyMs?: number): () => void;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

async function urlStatus(f: typeof fetch, url: string, timeoutMs: number): Promise<number> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url, { signal: ctrl.signal, redirect: 'follow' });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

async function posthogCounts(
  f: typeof fetch,
  o: PostHogOptions,
  module: string,
  version: string,
): Promise<HealthObservation> {
  const moduleProp = o.moduleProperty ?? 'versimo_module';
  const versionProp = o.versionProperty ?? 'versimo_version';
  if (!IDENT.test(moduleProp) || !IDENT.test(versionProp)) {
    throw new VersimoError('INVALID_INPUT', 'PostHog property names must be plain identifiers');
  }
  const minutes = o.windowMinutes ?? 5;
  if (!Number.isInteger(minutes) || minutes < 1) {
    throw new VersimoError('INVALID_INPUT', 'windowMinutes must be a whole number of 1 or more');
  }
  const host = (o.host ?? 'https://us.posthog.com').replace(/\/+$/, '');
  const query =
    `SELECT countIf(event = '$exception'), count() FROM events ` +
    `WHERE properties.${moduleProp} = {module} AND properties.${versionProp} = {version} ` +
    `AND timestamp > now() - toIntervalMinute(${minutes})`;
  let res: Response;
  try {
    res = await f(`${host}/api/projects/${encodeURIComponent(String(o.projectId))}/query/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query, values: { module, version } } }),
    });
  } catch (err) {
    throw new VersimoError('SOURCE_ERROR', `PostHog query failed: ${(err as Error).message}`);
  }
  if (!res.ok) throw new VersimoError('SOURCE_ERROR', `PostHog query returned ${res.status}`);
  const body = (await res.json()) as { results?: unknown[][] };
  const row = body.results?.[0];
  const errors = Number(row?.[0] ?? 0);
  const requests = Number(row?.[1] ?? 0);
  if (!Number.isInteger(errors) || !Number.isInteger(requests)) {
    throw new VersimoError('SOURCE_ERROR', 'PostHog query returned an unexpected shape');
  }
  return { requests, errors };
}

function alertText(a: Omit<HealthAlert, 'text'>): string {
  const checks = a.failures.map((f) => f.check).join(', ');
  const tail = a.rolledBack ? `Rolled back to ${a.current}.` : 'There is no last version to roll back to.';
  return `Versimo: ${a.module} ${a.version} failed its health checks (${checks}). ${tail}`;
}

export function createHealthMonitor(options: MonitorOptions): HealthMonitor {
  const now = () => new Date(options.now?.() ?? Date.now());
  const f = () => {
    const impl = options.fetch ?? globalThis.fetch;
    if (!impl) throw new VersimoError('SOURCE_ERROR', 'No fetch available. Pass the `fetch` option.');
    return impl;
  };
  const checksFor = (module: string) =>
    typeof options.checks === 'function' ? options.checks(module) : options.checks[module];
  // The version we last alerted about, per module, so a failure that cannot be rolled back alerts once.
  const alerted = new Map<string, string>();

  async function sendAlert(a: HealthAlert): Promise<void> {
    if (options.alert === undefined) return;
    if (typeof options.alert === 'function') return options.alert(a);
    const res = await f()(options.alert, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(a),
    });
    if (!res.ok) throw new VersimoError('SOURCE_ERROR', `Alert webhook returned ${res.status}`);
  }

  async function check(module: string): Promise<HealthReport> {
    const record = await options.store.read(module);
    if (record === null || record === undefined) throw new VersimoError('NOT_FOUND', `No record for module "${module}"`);
    const valid = validateRecord(record);
    if (!valid.ok) throw new VersimoError('INVALID_RECORD', `Invalid record for "${module}": ${valid.errors.join('; ')}`);

    const checks = checksFor(module) ?? {};
    let observation: HealthObservation = {};
    if (options.posthog && checks.maxErrorRate !== undefined) {
      observation = { ...observation, ...(await posthogCounts(f(), options.posthog, module, record.current)) };
    }
    if (checks.url !== undefined) {
      observation.urlStatus = await urlStatus(f(), checks.url, options.urlTimeoutMs ?? 5000);
    }
    if (options.observe) observation = { ...observation, ...(await options.observe(module, record)) };

    const at = now();
    const result = checkHealth(record, checks, observation, { now: at, by: options.by });
    if (result.rolledBack) await options.store.write(result.record);

    if (result.verdict.healthy) {
      alerted.delete(module);
    } else if (result.rolledBack || alerted.get(module) !== record.current) {
      alerted.set(module, record.current);
      const base = {
        module,
        at: at.toISOString(),
        version: record.current,
        rolledBack: result.rolledBack,
        current: result.record.current,
        failures: result.verdict.failures,
      };
      await sendAlert({ ...base, text: alertText(base) });
    }
    return { ...result, module, observation };
  }

  function start(modules: string[], everyMs = 60_000): () => void {
    const onError = options.onError ?? ((m, e) => console.warn(`versimo health check for ${m} failed:`, e));
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        for (const m of modules) {
          try {
            await check(m);
          } catch (err) {
            onError(m, err);
          }
        }
      } finally {
        running = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), everyMs);
    return () => clearInterval(timer);
  }

  return { check, start };
}
