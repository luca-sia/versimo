import { rollback } from './transitions.js';
import { VersimoError, type ModuleRecord, type TransitionOptions } from './types.js';

export type HealthCheckName = 'errorRate' | 'latency' | 'url';

/** Limits for one module. Leave a check out to turn it off. */
export interface HealthChecks {
  /** Highest share of failed requests, from 0 to 1. Fails when errors / requests is above it. */
  maxErrorRate?: number;
  /** Highest latency in milliseconds, usually p95. Fails when the latency is above it. */
  maxLatencyMs?: number;
  /** A URL that must answer with a 2xx status. */
  url?: string;
  /** The error rate is only judged once there are at least this many requests. Default 1. */
  minRequests?: number;
}

/** What was measured for the current version. A missing value means that check is skipped. */
export interface HealthObservation {
  requests?: number;
  errors?: number;
  latencyMs?: number;
  /** HTTP status of the check URL. 0 means it could not be reached. */
  urlStatus?: number;
}

export interface HealthFailure {
  check: HealthCheckName;
  /** The measured value: the error rate, the latency or the status. */
  value: number;
  /** The limit it broke, or null for the URL check. */
  limit: number | null;
}

export interface HealthVerdict {
  healthy: boolean;
  /** Failed checks, always in the order errorRate, latency, url. */
  failures: HealthFailure[];
}

export interface HealthResult {
  /** The record after the check. The same record when nothing changed. */
  record: ModuleRecord;
  verdict: HealthVerdict;
  rolledBack: boolean;
}

/** Recorded as `by` in history when the caller gives no name. */
export const HEALTH_ACTOR = 'versimo-health';

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

function invalid(message: string): never {
  throw new VersimoError('INVALID_INPUT', message);
}

function checkInputs(checks: HealthChecks, obs: HealthObservation): void {
  const { maxErrorRate, maxLatencyMs, url, minRequests } = checks;
  if (maxErrorRate !== undefined && (!isNumber(maxErrorRate) || maxErrorRate < 0 || maxErrorRate > 1)) {
    invalid('maxErrorRate must be a number from 0 to 1');
  }
  if (maxLatencyMs !== undefined && (!isNumber(maxLatencyMs) || maxLatencyMs < 0)) {
    invalid('maxLatencyMs must be a number of 0 or more');
  }
  if (url !== undefined && (typeof url !== 'string' || url === '')) invalid('url must be a non-empty string');
  if (minRequests !== undefined && !isCount(minRequests)) invalid('minRequests must be an integer of 0 or more');
  if (obs.requests !== undefined && !isCount(obs.requests)) invalid('requests must be an integer of 0 or more');
  if (obs.errors !== undefined && !isCount(obs.errors)) invalid('errors must be an integer of 0 or more');
  if (obs.errors !== undefined && obs.requests !== undefined && obs.errors > obs.requests) {
    invalid('errors cannot be more than requests');
  }
  if (obs.latencyMs !== undefined && (!isNumber(obs.latencyMs) || obs.latencyMs < 0)) {
    invalid('latencyMs must be a number of 0 or more');
  }
  if (obs.urlStatus !== undefined && !isCount(obs.urlStatus)) invalid('urlStatus must be an integer of 0 or more');
}

/** Judges one observation against the checks. Pure, and the same in every language. */
export function evaluateHealth(checks: HealthChecks, obs: HealthObservation): HealthVerdict {
  checkInputs(checks, obs);
  const failures: HealthFailure[] = [];
  const { requests, errors, latencyMs, urlStatus } = obs;

  if (checks.maxErrorRate !== undefined && requests !== undefined && errors !== undefined) {
    if (requests >= Math.max(1, checks.minRequests ?? 1)) {
      const rate = errors / requests;
      if (rate > checks.maxErrorRate) failures.push({ check: 'errorRate', value: rate, limit: checks.maxErrorRate });
    }
  }
  if (checks.maxLatencyMs !== undefined && latencyMs !== undefined && latencyMs > checks.maxLatencyMs) {
    failures.push({ check: 'latency', value: latencyMs, limit: checks.maxLatencyMs });
  }
  if (checks.url !== undefined && urlStatus !== undefined && (urlStatus < 200 || urlStatus > 299)) {
    failures.push({ check: 'url', value: urlStatus, limit: null });
  }
  return { healthy: failures.length === 0, failures };
}

/**
 * Judges current and, when it fails, steps back to last on its own.
 * The rollback is recorded in history with the failed checks as the reason,
 * for example `health: errorRate, latency`. With no last there is nothing
 * to go back to, so the record is left as it is and only the verdict says so.
 */
export function checkHealth(
  record: ModuleRecord,
  checks: HealthChecks,
  obs: HealthObservation,
  opts: TransitionOptions = {},
): HealthResult {
  const verdict = evaluateHealth(checks, obs);
  if (verdict.healthy || record.last === null) return { record, verdict, rolledBack: false };
  const reason = `health: ${verdict.failures.map((f) => f.check).join(', ')}`;
  const next = rollback(record, { ...opts, by: opts.by ?? HEALTH_ACTOR, reason });
  return { record: next, verdict, rolledBack: true };
}
