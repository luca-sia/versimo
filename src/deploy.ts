import { VersimoError } from './types.js';

export interface DeployModule {
  module: string;
  last: string | null;
  current: string;
  next: string | null;
  rollout: number;
  healthy: boolean;
  updatedAt: string;
}

export interface DeployClientOptions {
  /** The project's deploy key from versimo.dev, `vdk_...`. Keep it in CI secrets only. */
  key: string;
  /** Default `https://versimo.dev`. */
  base?: string;
  /** Fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface DeployClient {
  list(): Promise<DeployModule[]>;
  create(module: string, current: string, last?: string): Promise<DeployModule>;
  draft(module: string, version: string, opts?: { patch?: boolean }): Promise<DeployModule>;
  rollout(module: string, share: number): Promise<DeployModule>;
  promote(module: string): Promise<DeployModule>;
  rollback(module: string): Promise<DeployModule>;
}

/** Changes a versimo.dev project's modules from CI, with its deploy key. */
export function createDeployClient(options: DeployClientOptions): DeployClient {
  const base = `${(options.base ?? 'https://versimo.dev').replace(/\/+$/, '')}/api/deploy/modules`;

  async function call(method: 'GET' | 'POST', path: string, body?: object): Promise<Record<string, unknown>> {
    const f = options.fetch ?? globalThis.fetch;
    const res = await f(base + path, {
      method,
      headers: { authorization: `Bearer ${options.key}`, 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const reason = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
      throw new VersimoError(res.status === 401 ? 'SOURCE_ERROR' : 'INVALID_INPUT', `Versimo refused: ${reason}`);
    }
    return data;
  }

  const one = async (path: string, body?: object) => (await call('POST', path, body)).module as DeployModule;
  const at = (module: string, action: string) => `/${encodeURIComponent(module)}/${action}`;

  return {
    list: async () => (await call('GET', '')).modules as DeployModule[],
    create: (module, current, last) => one('', { module, current, last }),
    draft: (module, version, opts) => one(at(module, 'draft'), { version, patch: opts?.patch === true }),
    rollout: (module, share) => one(at(module, 'rollout'), { rollout: share }),
    promote: (module) => one(at(module, 'promote')),
    rollback: (module) => one(at(module, 'rollback')),
  };
}
