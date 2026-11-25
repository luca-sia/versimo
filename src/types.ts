export type Action = 'draft' | 'promote' | 'rollback' | 'rollout' | 'patch';

export interface HistoryEntry {
  /** ISO 8601 date-time. */
  at: string;
  action: Action;
  from: string | null;
  to: string | null;
  by?: string;
  /** Why the change was made, for example `health: errorRate`. */
  reason?: string;
}

export interface ModuleRecord {
  $schema?: string;
  /** Lower-case slug, for example `billing` or `sign-in`. */
  module: string;
  last: string | null;
  current: string;
  next: string | null;
  /** Share of users on `next`, an integer from 0 to 100. */
  rollout: number;
  /** Health of `current`. When false, users fall back to `last`. */
  healthy: boolean;
  /** ISO 8601 date-time. */
  updatedAt: string;
  history?: HistoryEntry[];
}

export interface Context {
  userId?: string;
}

export type Channel = 'next' | 'current' | 'last';

export type ResolutionReason = 'ROLLOUT' | 'DEFAULT' | 'NO_USER' | 'UNHEALTHY';

export interface Resolution {
  version: string;
  channel: Channel;
  reason: ResolutionReason;
  /** The user's bucket from 0 to 99, or null when there was no user id. */
  bucket: number | null;
}

export interface TransitionOptions {
  /** Who made the change. Recorded in history. */
  by?: string;
  /** Time of the change. Defaults to now. */
  now?: Date | string | number;
  /** Why the change was made. Recorded in history. */
  reason?: string;
}

export type ErrorCode = 'INVALID_INPUT' | 'INVALID_RECORD' | 'NOT_FOUND' | 'SOURCE_ERROR';

export class VersimoError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'VersimoError';
    this.code = code;
  }
}
