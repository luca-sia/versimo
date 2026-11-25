import { VersimoError, type Resolution } from './types.js';
import type { VersimoClient } from './client.js';

/** Structural copies of the OpenFeature types, so this package imports nothing. */
export interface EvaluationContext {
  targetingKey?: string;
  [key: string]: unknown;
}

export interface ResolutionDetails<T> {
  value: T;
  variant?: string;
  reason?: string;
  errorCode?: string;
  errorMessage?: string;
}

const REASONS: Record<Resolution['reason'], string> = {
  ROLLOUT: 'SPLIT',
  DEFAULT: 'STATIC',
  NO_USER: 'STATIC',
  UNHEALTHY: 'DISABLED',
};

/**
 * The flag key is the module slug. The value is the version string.
 * The targeting key is the user id. The variant is `next`, `current` or `last`.
 */
export class VersimoProvider {
  readonly metadata = { name: 'versimo' } as const;

  constructor(private readonly client: VersimoClient) {}

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext = {},
  ): Promise<ResolutionDetails<string>> {
    try {
      const userId = typeof context.targetingKey === 'string' ? context.targetingKey : undefined;
      const r = await this.client.resolve(flagKey, { userId });
      return { value: r.version, variant: r.channel, reason: REASONS[r.reason] };
    } catch (err) {
      const code = err instanceof VersimoError ? err.code : 'SOURCE_ERROR';
      return {
        value: defaultValue,
        reason: 'ERROR',
        errorCode: code === 'NOT_FOUND' ? 'FLAG_NOT_FOUND' : code === 'INVALID_INPUT' ? 'INVALID_CONTEXT' : 'GENERAL',
        errorMessage: (err as Error).message,
      };
    }
  }

  async resolveBooleanEvaluation(_flagKey: string, defaultValue: boolean): Promise<ResolutionDetails<boolean>> {
    return mismatch(defaultValue);
  }

  async resolveNumberEvaluation(_flagKey: string, defaultValue: number): Promise<ResolutionDetails<number>> {
    return mismatch(defaultValue);
  }

  async resolveObjectEvaluation<T>(_flagKey: string, defaultValue: T): Promise<ResolutionDetails<T>> {
    return mismatch(defaultValue);
  }
}

function mismatch<T>(value: T): ResolutionDetails<T> {
  return {
    value,
    reason: 'ERROR',
    errorCode: 'TYPE_MISMATCH',
    errorMessage: 'Versimo flags are version strings. Use resolveStringEvaluation.',
  };
}
