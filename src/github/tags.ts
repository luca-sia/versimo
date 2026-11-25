import { compareSemver, isSemver } from '../semver.js';
import type { ModuleRecord } from '../types.js';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ModuleTag {
  module: string;
  version: string;
}

/**
 * Reads a tag of the form `module/vX.Y.Z`, for example `billing/v2.4.0`.
 * The module must be a lower-case slug. Anything else gives null, so tags
 * such as `v1.0.0` or `packages/go/v0.2.0` are ignored.
 */
export function parseModuleTag(tag: string): ModuleTag | null {
  const name = tag.startsWith('refs/tags/') ? tag.slice('refs/tags/'.length) : tag;
  const slash = name.indexOf('/');
  if (slash < 1) return null;
  const module = name.slice(0, slash);
  const rest = name.slice(slash + 1);
  if (!SLUG.test(module) || !rest.startsWith('v')) return null;
  const version = rest.slice(1);
  return isSemver(version) ? { module, version } : null;
}

/** Groups tags by module. Each list is sorted from newest to oldest, without duplicates. */
export function modulesFromTags(tags: Iterable<string>): Record<string, string[]> {
  const found: Record<string, Set<string>> = {};
  for (const tag of tags) {
    const parsed = parseModuleTag(tag);
    if (!parsed) continue;
    (found[parsed.module] ??= new Set()).add(parsed.version);
  }
  const out: Record<string, string[]> = {};
  for (const module of Object.keys(found).sort()) {
    out[module] = [...found[module]!].sort((a, b) => compareSemver(b, a));
  }
  return out;
}

const isStable = (v: string) => !/^[^+]*-/.test(v);

/**
 * A first record for a module that has no record yet.
 * Current is the newest stable version and last the one before it.
 * Next stays empty: drafting next is a choice, not something a tag decides.
 * Returns null when the module has no stable version.
 */
export function recordFromTags(
  module: string,
  versions: readonly string[],
  now: Date | string | number = new Date(),
): ModuleRecord | null {
  const stable = versions.filter((v) => isSemver(v) && isStable(v)).sort((a, b) => compareSemver(b, a));
  const unique = stable.filter((v, i) => i === 0 || compareSemver(v, stable[i - 1]!) !== 0);
  if (unique.length === 0) return null;
  return {
    module,
    last: unique[1] ?? null,
    current: unique[0]!,
    next: null,
    rollout: 0,
    healthy: true,
    updatedAt: new Date(now).toISOString(),
  };
}
