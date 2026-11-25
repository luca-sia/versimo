import { compareSemver, isSemver } from './semver.js';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ACTIONS = ['draft', 'promote', 'rollback', 'rollout', 'patch'];
const KEYS = ['$schema', 'module', 'last', 'current', 'next', 'rollout', 'healthy', 'updatedAt', 'history'];
const ENTRY_KEYS = ['at', 'action', 'from', 'to', 'by', 'reason'];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isDateTime = (v: unknown) =>
  typeof v === 'string' && DATE_TIME.test(v) && !Number.isNaN(Date.parse(v));

function checkEntry(entry: unknown, path: string, errors: string[]): void {
  if (!isObject(entry)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.includes(key)) errors.push(`${path}.${key} is not allowed`);
  }
  if (!isDateTime(entry.at)) errors.push(`${path}.at must be an ISO 8601 date-time`);
  if (typeof entry.action !== 'string' || !ACTIONS.includes(entry.action)) {
    errors.push(`${path}.action must be one of ${ACTIONS.join(', ')}`);
  }
  for (const key of ['from', 'to'] as const) {
    if (entry[key] !== null && typeof entry[key] !== 'string') {
      errors.push(`${path}.${key} must be a string or null`);
    }
  }
  if (entry.by !== undefined && typeof entry.by !== 'string') errors.push(`${path}.by must be a string`);
  if (entry.reason !== undefined && typeof entry.reason !== 'string') errors.push(`${path}.reason must be a string`);
}

/** Checks a record by hand. It never throws. Each error names the field. */
export function validateRecord(record: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(record)) return { ok: false, errors: ['record must be an object'] };

  for (const key of Object.keys(record)) {
    if (!KEYS.includes(key)) errors.push(`${key} is not allowed`);
  }
  if (record.$schema !== undefined && typeof record.$schema !== 'string') {
    errors.push('$schema must be a string');
  }
  if (typeof record.module !== 'string' || !SLUG.test(record.module)) {
    errors.push('module must be a lower-case slug such as "billing" or "sign-in"');
  }
  if (record.last !== null && !isSemver(record.last)) errors.push('last must be a semver string or null');
  if (!isSemver(record.current)) errors.push('current must be a semver string');
  if (record.next !== null && !isSemver(record.next)) errors.push('next must be a semver string or null');
  if (!Number.isInteger(record.rollout) || (record.rollout as number) < 0 || (record.rollout as number) > 100) {
    errors.push('rollout must be an integer from 0 to 100');
  }
  if (typeof record.healthy !== 'boolean') errors.push('healthy must be a boolean');
  if (!isDateTime(record.updatedAt)) errors.push('updatedAt must be an ISO 8601 date-time');

  if (record.history !== undefined) {
    if (Array.isArray(record.history)) {
      record.history.forEach((e, i) => checkEntry(e, `history[${i}]`, errors));
    } else {
      errors.push('history must be an array');
    }
  }

  if (errors.length === 0) {
    const { last, current, next, rollout } = record as {
      last: string | null;
      current: string;
      next: string | null;
      rollout: number;
    };
    if (next !== null && compareSemver(next, current) <= 0) errors.push('next must be greater than current');
    if (last !== null && compareSemver(last, current) >= 0) errors.push('last must be lower than current');
    if (next === null && rollout !== 0) errors.push('rollout must be 0 when next is null');
  }

  return { ok: errors.length === 0, errors };
}
