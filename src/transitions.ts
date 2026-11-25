import { compareSemver, isSemver } from './semver.js';
import {
  VersimoError,
  type Action,
  type HistoryEntry,
  type ModuleRecord,
  type TransitionOptions,
} from './types.js';

function stamp(opts: TransitionOptions): string {
  const d = new Date(opts.now ?? Date.now());
  if (Number.isNaN(d.getTime())) throw new VersimoError('INVALID_INPUT', 'Invalid `now` option');
  return d.toISOString();
}

function apply(
  record: ModuleRecord,
  changes: Partial<ModuleRecord>,
  action: Action,
  from: string | null,
  to: string | null,
  opts: TransitionOptions,
): ModuleRecord {
  const at = stamp(opts);
  const entry: HistoryEntry = { at, action, from, to };
  if (opts.by !== undefined) entry.by = opts.by;
  if (opts.reason !== undefined) entry.reason = opts.reason;
  return { ...record, ...changes, updatedAt: at, history: [...(record.history ?? []), entry] };
}

/** Sets a new next version at 0% rollout. It replaces any next already drafted. */
export function draftNext(
  record: ModuleRecord,
  version: string,
  opts: TransitionOptions & { patch?: boolean } = {},
): ModuleRecord {
  if (!isSemver(version)) throw new VersimoError('INVALID_INPUT', `Invalid semver: ${version}`);
  if (compareSemver(version, record.current) <= 0) {
    throw new VersimoError('INVALID_INPUT', `Next ${version} must be greater than current ${record.current}`);
  }
  return apply(
    record,
    { next: version, rollout: 0 },
    opts.patch ? 'patch' : 'draft',
    record.next ?? record.current,
    version,
    opts,
  );
}

/** Moves next to current and current to last. Rollout resets to 0. */
export function promote(record: ModuleRecord, opts: TransitionOptions = {}): ModuleRecord {
  if (record.next === null) throw new VersimoError('INVALID_INPUT', 'Nothing to promote: next is empty');
  return apply(
    record,
    { last: record.current, current: record.next, next: null, rollout: 0, healthy: true },
    'promote',
    record.current,
    record.next,
    opts,
  );
}

/**
 * Puts last back as current. The failed version and any drafted next are dropped,
 * so there is nothing left to roll back to until the next promote.
 */
export function rollback(record: ModuleRecord, opts: TransitionOptions = {}): ModuleRecord {
  if (record.last === null) throw new VersimoError('INVALID_INPUT', 'Nothing to roll back to: last is empty');
  return apply(
    record,
    { last: null, current: record.last, next: null, rollout: 0, healthy: true },
    'rollback',
    record.current,
    record.last,
    opts,
  );
}

/** Sets the share of users on next, an integer from 0 to 100. */
export function setRollout(record: ModuleRecord, n: number, opts: TransitionOptions = {}): ModuleRecord {
  if (!Number.isInteger(n) || n < 0 || n > 100) {
    throw new VersimoError('INVALID_INPUT', 'Rollout must be an integer from 0 to 100');
  }
  if (n > 0 && record.next === null) {
    throw new VersimoError('INVALID_INPUT', 'Cannot roll out: next is empty');
  }
  return apply(record, { rollout: n }, 'rollout', String(record.rollout), String(n), opts);
}
