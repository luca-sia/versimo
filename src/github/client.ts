import { VersimoError } from '../types.js';
import { modulesFromTags } from './tags.js';

const API = 'https://api.github.com';
const PROTECTED = ['main', 'master'];
// A conservative subset of what git allows in a branch name.
const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._\/-]+$/;

export interface GitHubOptions {
  /** An installation token, or any token with the same rights. */
  token: string;
  /** Fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** REST base URL. Default https://api.github.com. */
  apiUrl?: string;
}

export interface FileChange {
  path: string;
  /** New UTF-8 content of the file. */
  content: string;
}

export type MergeMethod = 'SQUASH' | 'MERGE' | 'REBASE';

export interface PullRequestInput {
  owner: string;
  repo: string;
  /** New branch to create. It must not exist yet and must not be the base or the default branch. */
  head: string;
  /** Branch to merge into. Defaults to the repository's default branch. */
  base?: string;
  title: string;
  body?: string;
  /** Commit message. Defaults to the title. */
  message?: string;
  files: FileChange[];
  /** Turn on auto merge once the PR is open. Default SQUASH. Pass false to leave it off. */
  autoMerge?: MergeMethod | false;
}

export interface PullRequestResult {
  number: number;
  url: string;
  head: string;
  base: string;
  /** True when auto merge was turned on. */
  autoMerge: boolean;
  /** Why auto merge could not be turned on, when it could not. */
  autoMergeError?: string;
}

export interface GitHubClient {
  /** Every tag name in the repository. */
  listTags(owner: string, repo: string): Promise<string[]>;
  /** Modules and their versions, read from `module/vX.Y.Z` tags, newest first. */
  moduleVersions(owner: string, repo: string): Promise<Record<string, string[]>>;
  /**
   * Commits the files to a new branch and opens a pull request.
   * This is the only write the client can make. It creates a new branch and
   * never moves an existing one, so it cannot push to main.
   */
  openPullRequest(input: PullRequestInput): Promise<PullRequestResult>;
}

type Json = Record<string, any>;

function request(opts: GitHubOptions) {
  const base = (opts.apiUrl ?? API).replace(/\/+$/, '');
  return async (method: string, path: string, body?: unknown): Promise<Json | Json[]> => {
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new VersimoError('SOURCE_ERROR', 'No fetch available. Pass the `fetch` option.');
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${opts.token}`,
          'User-Agent': 'versimo',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new VersimoError('SOURCE_ERROR', `GitHub ${method} ${path} failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      if (res.ok) throw new VersimoError('SOURCE_ERROR', `GitHub ${method} ${path}: the answer was not JSON`);
    }
    if (res.status === 404) throw new VersimoError('NOT_FOUND', `GitHub ${method} ${path}: not found`);
    if (!res.ok) {
      const message = typeof data?.message === 'string' ? data.message : res.statusText;
      throw new VersimoError('SOURCE_ERROR', `GitHub ${method} ${path}: ${res.status} ${message}`);
    }
    return data;
  };
}

const enc = encodeURIComponent;

export function createGitHub(opts: GitHubOptions): GitHubClient {
  if (!opts || typeof opts.token !== 'string' || !opts.token) {
    throw new VersimoError('INVALID_INPUT', 'token is required');
  }
  const call = request(opts);
  const repoPath = (owner: string, repo: string) => `/repos/${enc(owner)}/${enc(repo)}`;

  async function listTags(owner: string, repo: string): Promise<string[]> {
    const names: string[] = [];
    for (let page = 1; ; page++) {
      const batch = (await call('GET', `${repoPath(owner, repo)}/tags?per_page=100&page=${page}`)) as Json[];
      for (const t of batch) names.push(t.name);
      if (batch.length < 100) return names;
    }
  }

  async function openPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    const { owner, repo, head, title, files } = input;
    if (!title) throw new VersimoError('INVALID_INPUT', 'title is required');
    if (!Array.isArray(files) || files.length === 0) throw new VersimoError('INVALID_INPUT', 'files must not be empty');
    if (typeof head !== 'string' || !BRANCH.test(head)) {
      throw new VersimoError('INVALID_INPUT', `head ${JSON.stringify(head)} is not a valid branch name`);
    }
    const path = repoPath(owner, repo);
    const info = (await call('GET', path)) as Json;
    const base = input.base ?? (info.default_branch as string);
    if (head === base || head === info.default_branch || PROTECTED.includes(head)) {
      throw new VersimoError('INVALID_INPUT', `Versimo never writes to ${head}. Use a new branch for the PR.`);
    }

    const ref = (await call('GET', `${path}/git/ref/heads/${base.split('/').map(enc).join('/')}`)) as Json;
    const parent = ref.object.sha as string;
    const commit = (await call('GET', `${path}/git/commits/${parent}`)) as Json;
    const tree = (await call('POST', `${path}/git/trees`, {
      base_tree: commit.tree.sha,
      tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
    })) as Json;
    const created = (await call('POST', `${path}/git/commits`, {
      message: input.message ?? title,
      tree: tree.sha,
      parents: [parent],
    })) as Json;
    // Create, never update: this fails if the branch already exists.
    await call('POST', `${path}/git/refs`, { ref: `refs/heads/${head}`, sha: created.sha });
    const pr = (await call('POST', `${path}/pulls`, { title, head, base, body: input.body ?? '' })) as Json;

    const result: PullRequestResult = { number: pr.number, url: pr.html_url, head, base, autoMerge: false };
    const method = input.autoMerge ?? 'SQUASH';
    if (method === false) return result;
    try {
      const gql = (await call('POST', '/graphql', {
        query:
          'mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { clientMutationId } }',
        variables: { id: pr.node_id, method },
      })) as Json;
      if (Array.isArray(gql.errors) && gql.errors.length > 0) {
        result.autoMergeError = String(gql.errors[0]?.message ?? 'auto merge failed');
      } else {
        result.autoMerge = true;
      }
    } catch (err) {
      result.autoMergeError = (err as Error).message;
    }
    return result;
  }

  return {
    listTags,
    moduleVersions: async (owner, repo) => modulesFromTags(await listTags(owner, repo)),
    openPullRequest,
  };
}

export interface InstallationTokenOptions {
  /** A JWT from `createAppJwt`. */
  jwt: string;
  installationId: string | number;
  fetch?: typeof fetch;
  apiUrl?: string;
}

/** Swaps an app JWT for an installation token. Tokens last one hour. */
export async function getInstallationToken(
  opts: InstallationTokenOptions,
): Promise<{ token: string; expiresAt: string }> {
  const call = request({ token: opts.jwt, fetch: opts.fetch, apiUrl: opts.apiUrl });
  const data = (await call('POST', `/app/installations/${enc(String(opts.installationId))}/access_tokens`, {})) as Json;
  return { token: data.token, expiresAt: data.expires_at };
}
