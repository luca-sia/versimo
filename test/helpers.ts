import type { ModuleRecord } from '../src/index.js';

export function makeRecord(overrides: Partial<ModuleRecord> = {}): ModuleRecord {
  return {
    module: 'billing',
    last: '2.3.1',
    current: '2.4.0',
    next: '2.5.0',
    rollout: 10,
    healthy: true,
    updatedAt: '2026-03-12T09:30:00Z',
    ...overrides,
  };
}
