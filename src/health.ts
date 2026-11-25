import { rollback } from './transitions.js';
import {
  VersimoError,
  type HealthOptions,
  type HealthResult,
  type HealthSamples,
  type HealthThresholds,
  type ModuleRecord,
} from './types.js';

const DEFAULT_MAX_ERROR_RATE = 0.05;
const DEFAULT_MIN_REQUESTS = 20;

function pct(n: number): string {
  return `${Math.round(n * 10000) / 100}%`;
}

/** Judges samples against thresholds. Pure. */
export function evaluateHealth(samples: HealthSamples, thresholds: HealthThresholds = {}): HealthResult {
  const maxErrorRate = thresholds.maxErrorRate ?? DEFAULT_MAX_ERROR_RATE;
  const minRequests = thresholds.minRequests ?? DEFAULT_MIN_REQUESTS;
  if (!(maxErrorRate >= 0 && maxErrorRate <= 1)) {
    throw new VersimoError('INVALID_INPUT', 'maxErrorRate must be from 0 to 1');
  }
  const reasons: string[] = [];

  if (samples.requests >= minRequests && samples.requests > 0) {
    const rate = samples.errors / samples.requests;
    if (rate > maxErrorRate) {
      reasons.push(`error rate ${pct(rate)} is above ${pct(maxErrorRate)}`);
    }
  }
  if (thresholds.maxP95Ms !== undefined && samples.p95Ms !== undefined && samples.p95Ms > thresholds.maxP95Ms) {
    reasons.push(`p95 latency ${samples.p95Ms}ms is above ${thresholds.maxP95Ms}ms`);
  }
  for (const check of samples.checks ?? []) {
    if (!check.ok) reasons.push(`check failed: ${check.name}`);
  }
  return { healthy: reasons.length === 0, reasons };
}

/** Probes a URL. Ok only on a 2xx response within the timeout. Never throws. */
export async function checkUrl(
  url: string,
  opts: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<{ name: string; ok: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('timeout'));
      }, timeoutMs);
    });
    const res = await Promise.race([doFetch(url, { signal: controller.signal }), timeout]);
    return { name: url, ok: res.status >= 200 && res.status < 300 };
  } catch {
    return { name: url, ok: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Applies a health result to a record and returns a new one.
 * A healthy result returns the record as it is. An unhealthy result rolls back to last
 * when there is one, and otherwise marks the record unhealthy.
 */
export function applyHealth(record: ModuleRecord, result: HealthResult, options: HealthOptions = {}): ModuleRecord {
  if (result.healthy) return record;
  const { onAlert, ...transition } = options;
  const opts = { ...transition, by: transition.by ?? 'versimo-health' };

  let next: ModuleRecord;
  let action: 'rollback' | 'unhealthy';
  if (record.last !== null) {
    next = rollback(record, opts);
    action = 'rollback';
  } else {
    // Already marked: nothing changes, so no history entry and no alert.
    if (!record.healthy) return record;
    const d = new Date(opts.now ?? Date.now());
    if (Number.isNaN(d.getTime())) throw new VersimoError('INVALID_INPUT', 'Invalid `now` option');
    const at = d.toISOString();
    // The history Action set has no health entry. A rollback entry with `to` null says
    // that a step back was wanted and there was nowhere to go.
    next = {
      ...record,
      healthy: false,
      updatedAt: at,
      history: [...(record.history ?? []), { at, action: 'rollback', from: record.current, to: null, by: opts.by }],
    };
    action = 'unhealthy';
  }
  onAlert?.({ module: record.module, action, reasons: [...result.reasons] });
  return next;
}
