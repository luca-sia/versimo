/**
 * Writes the share on next into the project's own PostHog, so apps that read
 * flags with `postHogRollout` follow the slider with no deploy. One flag per
 * module, key `versimo-<module>`, released to 100%, payload `{"rollout": n}`.
 * Only the share and the module slug are sent. No user data.
 */

import { postHogFlagKey } from '../../src/index.js';

export type Region = 'eu' | 'us';

/** PostHog's private API hosts. Only these two, so the Worker cannot be pointed anywhere else. */
export const POSTHOG_HOSTS: Record<Region, string> = {
  eu: 'https://eu.posthog.com',
  us: 'https://us.posthog.com',
};

export interface PosthogLink {
  region: Region;
  projectId: number;
  /** A PostHog personal API key with feature flag read and write. */
  apiKey: string;
}

export type SyncResult = 'synced' | 'failed' | 'off';

export const isRegion = (v: unknown): v is Region => v === 'eu' || v === 'us';

/** `phx_…abcd`, enough to recognise a key without showing it. */
export const keyHint = (key: string) => (key.length > 10 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '…');

export function posthog(link: PosthogLink, doFetch: typeof fetch) {
  const base = `${POSTHOG_HOSTS[link.region]}/api/projects/${link.projectId}/feature_flags/`;
  const headers = { authorization: `Bearer ${link.apiKey}`, 'content-type': 'application/json', accept: 'application/json' };

  async function find(key: string): Promise<number | null> {
    const res = await doFetch(`${base}?search=${encodeURIComponent(key)}&limit=100`, { headers, redirect: 'manual' });
    if (!res.ok) throw new Error(`posthog-list-${res.status}`);
    const data = (await res.json()) as { results?: { id?: unknown; key?: unknown; deleted?: unknown }[] };
    const hit = data.results?.find((f) => f.key === key && f.deleted !== true);
    return hit && typeof hit.id === 'number' ? hit.id : null;
  }

  return {
    /** True when PostHog accepts the key for this project and lets it read flags. */
    async check(): Promise<boolean> {
      const res = await doFetch(`${base}?limit=1`, { headers, redirect: 'manual' });
      return res.ok;
    },

    /** Creates or updates the module's flag with this share. */
    async setShare(module: string, rollout: number): Promise<void> {
      const key = postHogFlagKey(module);
      const flag = {
        name: `Versimo ${module}: share of users on next`,
        active: true,
        filters: {
          groups: [{ properties: [], rollout_percentage: 100 }],
          payloads: { true: JSON.stringify({ rollout }) },
        },
      };
      const id = await find(key);
      const res = await doFetch(id === null ? base : `${base}${id}/`, {
        method: id === null ? 'POST' : 'PATCH',
        headers,
        redirect: 'manual',
        body: JSON.stringify(id === null ? { key, ...flag } : flag),
      });
      if (!res.ok) throw new Error(`posthog-write-${res.status}`);
    },
  };
}
