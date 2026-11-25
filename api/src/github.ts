import { createAppJwt, createGitHub, getInstallationToken } from '../../src/github/index.js';

export interface GithubConfig {
  /** The GitHub App id. */
  appId: string;
  /** The app's URL name, as in github.com/apps/<slug>. */
  slug: string;
  /** The app's private key, PEM. */
  privateKey: string;
  webhookSecret: string;
  /** OAuth client id and secret of the app, to check who installed it. */
  clientId: string;
  clientSecret: string;
  /** Default https://api.github.com. */
  apiUrl?: string;
  /** Default https://github.com. */
  webUrl?: string;
}

const API = 'https://api.github.com';
const WEB = 'https://github.com';

function headers(token: string): HeadersInit {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'versimo',
    'x-github-api-version': '2022-11-28',
  };
}

/** What the API Worker asks of GitHub. One instance per request is fine. */
export function githubApp(config: GithubConfig, doFetch: typeof fetch) {
  const api = (config.apiUrl ?? API).replace(/\/+$/, '');
  const web = (config.webUrl ?? WEB).replace(/\/+$/, '');

  async function installationToken(installationId: number): Promise<string> {
    const jwt = await createAppJwt({ appId: config.appId, privateKey: config.privateKey });
    return (await getInstallationToken({ jwt, installationId, fetch: doFetch, apiUrl: api })).token;
  }

  async function pages<T>(token: string, path: string, pick: (body: any) => T[]): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const res = await doFetch(`${api}${path}${sep}per_page=100&page=${page}`, { headers: headers(token) });
      if (!res.ok) throw new Error(`GitHub ${path}: ${res.status}`);
      const batch = pick(await res.json());
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  return {
    installUrl(state: string): string {
      return `${web}/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`;
    },

    /**
     * True when the person who just installed the app can really see this
     * installation. The installation id in the callback URL can be forged, so
     * we ask GitHub with the person's own token.
     */
    async userHasInstallation(code: string, installationId: number): Promise<boolean> {
      const res = await doFetch(`${web}/login/oauth/access_token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'versimo' },
        body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
      });
      if (!res.ok) return false;
      const { access_token: token } = (await res.json()) as { access_token?: unknown };
      if (typeof token !== 'string' || !token) return false;
      const installs = await pages(token, '/user/installations', (b) => (b.installations ?? []) as { id: number }[]);
      return installs.some((i) => i.id === installationId);
    },

    /** owner/name of every repository the installation can see. */
    async repositories(installationId: number): Promise<string[]> {
      const token = await installationToken(installationId);
      const repos = await pages(token, '/installation/repositories', (b) => (b.repositories ?? []) as { full_name: string }[]);
      return repos.map((r) => r.full_name).sort((a, b) => a.localeCompare(b));
    },

    /** Modules and versions from the repository's module/vX.Y.Z tags. */
    async moduleVersions(installationId: number, repo: string): Promise<Record<string, string[]>> {
      const [owner, name] = repo.split('/') as [string, string];
      const token = await installationToken(installationId);
      return createGitHub({ token, fetch: doFetch, apiUrl: api }).moduleVersions(owner, name);
    },
  };
}

export type GithubApp = ReturnType<typeof githubApp>;
