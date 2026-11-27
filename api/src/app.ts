import {
  draftNext,
  promote,
  rollback,
  setRollout,
  validateRecord,
  VersimoError,
  type ModuleRecord,
} from '../../src/index.js';
import { parseModuleTag, recordFromTags, verifyWebhookSignature } from '../../src/github/index.js';
import { githubApp, type GithubConfig } from './github.js';
import { createOidc, type Oidc } from './oidc.js';
import { isRegion, keyHint, posthog, type PosthogLink, type SyncResult } from './posthog.js';
import { seal, unseal } from './seal.js';
import { cookie, pkceChallenge, randomToken, readCookie, sign, verify } from './session.js';
import type { AuditEntry, KeyKind, Store, StoredModule } from './store.js';

export interface Config {
  /** The OIDC issuer, https://lucasia.ai/api/auth. Its endpoints come from discovery. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** At least 32 characters. Signs the session and sign in cookies. */
  sessionSecret: string;
  /** Where the app lives, https://versimo.dev. */
  appOrigin: string;
  /** The GitHub app. Without it the GitHub routes answer 503. */
  github?: GithubConfig;
}

export interface Deps {
  store: Store;
  config: Config;
  fetch?: typeof fetch;
  /** Pass one to keep discovery and keys between apps. */
  oidc?: Oidc;
}

interface Session {
  uid: string;
  name: string | null;
  email: string | null;
  /** Set when CI acts with the deploy key. The history then names no user. */
  deployKey?: true;
}

interface SignIn {
  state: string;
  nonce: string;
  verifier: string;
  back: string;
}

const SESSION = 'versimo_session';
const SIGN_IN = 'versimo_signin';
const SESSION_TTL = 7 * 24 * 3600;
const SIGN_IN_TTL = 10 * 60;
const CALLBACK = '/app/callback';
const GITHUB_CALLBACK = '/app/github/callback';
const GITHUB_STATE_TTL = 15 * 60;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSTHOG_PURPOSE = 'posthog-key';

interface GithubState {
  uid: string;
  project: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
};

/** Only paths inside the app, so the return address cannot send someone off site. */
function safeBack(value: string | null): string {
  if (!value || !value.startsWith('/app') || value.startsWith('//') || value.includes('\\')) return '/app';
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Fall through.
  }
  throw new HttpError(400, 'Send a JSON object');
}

function projectName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < 1 || name.length > 80) throw new HttpError(400, 'A project name is 1 to 80 characters');
  return name;
}

const KEY_PREFIX: Record<KeyKind, string> = { read: 'vrk_', deploy: 'vdk_' };
const KEY_ROUTE: Record<string, KeyKind> = { 'read-key': 'read', 'deploy-key': 'deploy' };
const isKey = (kind: KeyKind, value: string | undefined): value is string =>
  !!value && value.startsWith(KEY_PREFIX[kind]) && /^[A-Za-z0-9_-]{32,64}$/.test(value.slice(4));
const RECORD_FILE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const toRecord = (m: StoredModule): ModuleRecord => ({ ...m, history: [] });

const isStable = (v: string) => !/^[^+]*-/.test(v);

const fromRecord = (r: ModuleRecord): StoredModule => ({
  module: r.module,
  last: r.last,
  current: r.current,
  next: r.next,
  rollout: r.rollout,
  healthy: r.healthy,
  updatedAt: r.updatedAt,
});

export function createApp(deps: Deps) {
  const { store, config } = deps;
  const doFetch = deps.fetch ?? fetch;
  const oidc = deps.oidc ?? createOidc(config.issuer, doFetch);

  function refused(error: unknown, headers: string[]): Response {
    console.warn(`sign in refused: ${error instanceof Error ? error.message : 'unknown'}`);
    return redirect('/app?signin=failed', headers);
  }

  async function session(request: Request): Promise<Session | null> {
    return verify<Session>(readCookie(request, SESSION), config.sessionSecret);
  }

  async function requireSession(request: Request): Promise<Session> {
    const s = await session(request);
    if (!s) throw new HttpError(401, 'Sign in first');
    // Cookies are SameSite=Lax. Checking Origin on writes closes the rest.
    if (request.method !== 'GET' && request.headers.get('origin') !== config.appOrigin) {
      throw new HttpError(403, 'Wrong origin');
    }
    return s;
  }

  async function login(url: URL): Promise<Response> {
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken(48);
    const back = safeBack(url.searchParams.get('return'));
    let target: URL;
    try {
      target = new URL((await oidc.endpoints()).authorize);
    } catch (error) {
      return refused(error, []);
    }
    target.search = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.appOrigin + CALLBACK,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
    }).toString();
    const signIn = await sign({ state, nonce, verifier, back } satisfies SignIn, config.sessionSecret, SIGN_IN_TTL);
    return redirect(target.toString(), [cookie(SIGN_IN, signIn, CALLBACK, SIGN_IN_TTL)]);
  }

  /** Swaps the code for tokens, checks the ID token and reads the profile of the same subject. */
  async function identify(code: string, signIn: SignIn) {
    const endpoints = await oidc.endpoints();
    // client_secret_basic: both halves are form encoded before the base64 (RFC 6749, 2.3.1).
    const basic = btoa(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`);
    const tokenResponse = await doFetch(endpoints.token, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.appOrigin + CALLBACK,
        code_verifier: signIn.verifier,
      }),
    });
    if (!tokenResponse.ok) throw new Error(`token-${tokenResponse.status}`);
    const tokens = (await tokenResponse.json()) as { access_token?: unknown; id_token?: unknown };
    const subject = await oidc.subject(tokens.id_token, { clientId: config.clientId, nonce: signIn.nonce });
    if (typeof tokens.access_token !== 'string') throw new Error('access-token-missing');

    // The issuer keeps name and email out of the ID token, so they come from userinfo.
    const infoResponse = await doFetch(endpoints.userinfo, {
      redirect: 'manual',
      headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' },
    });
    if (!infoResponse.ok) throw new Error(`userinfo-${infoResponse.status}`);
    const info = (await infoResponse.json()) as {
      sub?: unknown;
      email?: unknown;
      email_verified?: unknown;
      name?: unknown;
    };
    if (info.sub !== subject) throw new Error('userinfo-subject');
    return {
      issuer: config.issuer,
      subject,
      email: info.email_verified === true && typeof info.email === 'string' ? info.email : null,
      name: typeof info.name === 'string' ? info.name : null,
    };
  }

  async function callback(request: Request, url: URL): Promise<Response> {
    const clear = cookie(SIGN_IN, '', CALLBACK, 0);
    if (url.searchParams.get('error')) return redirect('/app?signin=cancelled', [clear]);
    const signIn = await verify<SignIn>(readCookie(request, SIGN_IN), config.sessionSecret);
    const code = url.searchParams.get('code');
    if (!signIn?.nonce || !code || url.searchParams.get('state') !== signIn.state) {
      return redirect('/app?signin=expired', [clear]);
    }

    let identity: Awaited<ReturnType<typeof identify>>;
    try {
      identity = await identify(code, signIn);
    } catch (error) {
      return refused(error, [clear]);
    }

    const user = await store.upsertUser(identity);
    const token = await sign(
      { uid: user.id, name: user.name, email: user.email } satisfies Session,
      config.sessionSecret,
      SESSION_TTL,
    );
    return redirect(signIn.back, [clear, cookie(SESSION, token, '/', SESSION_TTL)]);
  }

  async function project(s: Session, id: string | undefined) {
    if (!id || !UUID.test(id)) throw new HttpError(404, 'No such project');
    const p = await store.getProject(s.uid, id);
    if (!p) throw new HttpError(404, 'No such project');
    return p;
  }

  async function createModule(s: Session, projectId: string, request: Request) {
    const input = await body(request);
    const now = new Date().toISOString();
    const record: ModuleRecord = {
      module: typeof input.module === 'string' ? input.module : '',
      last: typeof input.last === 'string' && input.last !== '' ? input.last : null,
      current: typeof input.current === 'string' ? input.current : '',
      next: null,
      rollout: 0,
      healthy: true,
      updatedAt: now,
    };
    const check = validateRecord(record);
    if (!check.ok) throw new HttpError(400, check.errors.join('. '));
    const entry: AuditEntry = {
      module: record.module,
      at: now,
      action: 'create',
      from: null,
      to: record.current,
      by: s.name ?? s.email,
    };
    const ok = await store.createModule(projectId, fromRecord(record), entry, s.deployKey ? null : s.uid);
    if (!ok) throw new HttpError(409, `A module called ${record.module} already exists`);
    const synced = await syncShares(s.uid, projectId, [fromRecord(record)]);
    return json({ module: fromRecord(record), posthog: synced }, 201);
  }

  async function changeModule(s: Session, projectId: string, module: string, action: string, request: Request) {
    const input = await body(request);
    const by = s.name ?? s.email ?? undefined;
    const apply = (r: ModuleRecord): ModuleRecord => {
      switch (action) {
        case 'draft':
          return draftNext(r, String(input.version ?? ''), { by, patch: input.patch === true });
        case 'promote':
          return promote(r, { by });
        case 'rollback':
          return rollback(r, { by });
        case 'rollout':
          return setRollout(r, Number(input.rollout), { by });
        default:
          throw new HttpError(404, 'Not found');
      }
    };
    const updated = await store.updateModule(
      projectId,
      module,
      (stored) => {
        const next = apply(toRecord(stored));
        const entries: AuditEntry[] = (next.history ?? []).map((h) => ({
          module,
          at: h.at,
          action: h.action,
          from: h.from,
          to: h.to,
          by: h.by ?? null,
        }));
        return { record: fromRecord(next), entries };
      },
      s.deployKey ? null : s.uid,
    );
    if (!updated) throw new HttpError(404, 'No such module');
    return json({ module: updated, posthog: await syncShares(s.uid, projectId, [updated]) });
  }

  /** The project's PostHog with its key opened, 'off' when not connected, null when the key cannot be opened. */
  async function posthogLink(uid: string, projectId: string): Promise<PosthogLink | null | 'off'> {
    const stored = await store.getPosthog(uid, projectId);
    if (!stored) return 'off';
    const apiKey = await unseal(stored.sealedKey, config.sessionSecret, POSTHOG_PURPOSE);
    return apiKey ? { region: stored.region, projectId: stored.projectId, apiKey } : null;
  }

  /**
   * Writes each module's share to its PostHog flag. A PostHog failure never
   * undoes the change: the module is saved, and the answer says 'failed'.
   */
  async function syncShares(uid: string, projectId: string, modules: StoredModule[]): Promise<SyncResult> {
    const link = await posthogLink(uid, projectId);
    if (link === 'off') return 'off';
    if (!link) return 'failed';
    const client = posthog(link, doFetch);
    try {
      for (const m of modules) await client.setShare(m.module, m.rollout);
      return 'synced';
    } catch (error) {
      console.warn(`posthog sync failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return 'failed';
    }
  }

  async function keyProject(s: Session, projectId: string, kind: KeyKind, method: string): Promise<Response> {
    const field = kind === 'read' ? 'readKey' : 'deployKey';
    if (method === 'GET') return json({ [field]: Boolean(await store.hasKey(s.uid, projectId, kind)) });
    if (method === 'POST') {
      // A new key replaces the old one. Only its hash is kept, so it is shown this one time.
      const key = `${KEY_PREFIX[kind]}${randomToken(32)}`;
      await store.setKey(s.uid, projectId, kind, await sha256(key));
      return json({ [field]: key }, 201);
    }
    if (method === 'DELETE') {
      await store.setKey(s.uid, projectId, kind, null);
      return new Response(null, { status: 204 });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  /**
   * CI changes modules with the project's deploy key, sent as a bearer token.
   * Changes go through the same rules and history as the app, by "Deploy key".
   */
  async function deploy(request: Request, parts: string[]): Promise<Response> {
    const key = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    const owner = isKey('deploy', key) ? await store.projectForKey('deploy', await sha256(key)) : null;
    if (!owner) throw new HttpError(401, 'Send a valid deploy key');
    const actor: Session = { uid: owner.ownerId, name: 'Deploy key', email: null, deployKey: true };
    const [, , collection, moduleName, action, extra] = parts;
    if (collection !== 'modules' || extra) throw new HttpError(404, 'Not found');
    if (!moduleName && request.method === 'GET') return json({ modules: await store.listModules(owner.projectId) });
    if (!moduleName && request.method === 'POST') return createModule(actor, owner.projectId, request);
    if (moduleName && action && request.method === 'POST') {
      return changeModule(actor, owner.projectId, moduleName, action, request);
    }
    throw new HttpError(404, 'Not found');
  }

  /** One module's record for an app holding the project's read key. Every miss is the same 404. */
  async function publicRecord(key: string | undefined, file: string | undefined): Promise<Response> {
    const missing = () => json({ error: 'Not found' }, 404, { 'access-control-allow-origin': '*' });
    const slug = file?.match(RECORD_FILE)?.[1];
    if (!isKey('read', key) || !slug) return missing();
    const owner = await store.projectForKey('read', await sha256(key));
    if (!owner) return missing();
    const found = (await store.listModules(owner.projectId)).find((m) => m.module === slug);
    if (!found) return missing();
    return json(toRecord(found), 200, {
      'cache-control': 'public, max-age=15',
      'access-control-allow-origin': '*',
    });
  }

  async function posthogProject(s: Session, projectId: string, request: Request): Promise<Response> {
    const method = request.method;
    if (method === 'DELETE') {
      // The flags stay in PostHog. Apps keep the last share they read until someone changes it there.
      await store.setPosthog(s.uid, projectId, null);
      return new Response(null, { status: 204 });
    }
    if (method === 'GET') {
      const link = await posthogLink(s.uid, projectId);
      if (link === 'off') return json({ posthog: null });
      if (!link) return json({ posthog: null, error: 'The saved PostHog key can no longer be read. Connect again.' });
      return json({ posthog: { region: link.region, projectId: link.projectId, keyHint: keyHint(link.apiKey) } });
    }
    if (method === 'PUT') {
      const input = await body(request);
      const region = input.region;
      const phProject = Number(input.projectId);
      const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
      if (!isRegion(region)) throw new HttpError(400, 'region must be eu or us');
      if (!Number.isSafeInteger(phProject) || phProject <= 0) throw new HttpError(400, 'projectId must be the PostHog project number');
      if (apiKey.length < 10 || apiKey.length > 200 || /\s/.test(apiKey)) throw new HttpError(400, 'apiKey must be a PostHog personal API key');
      const link: PosthogLink = { region, projectId: phProject, apiKey };
      let accepted = false;
      try {
        accepted = await posthog(link, doFetch).check();
      } catch {
        accepted = false;
      }
      if (!accepted) {
        throw new HttpError(400, 'PostHog did not accept that key for this project. It needs feature flag read and write.');
      }
      await store.setPosthog(s.uid, projectId, {
        region,
        projectId: phProject,
        sealedKey: await seal(apiKey, config.sessionSecret, POSTHOG_PURPOSE),
      });
      const synced = await syncShares(s.uid, projectId, await store.listModules(projectId));
      return json({ posthog: { region, projectId: phProject, keyHint: keyHint(apiKey) }, synced });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  function github() {
    if (!config.github) throw new HttpError(503, 'The GitHub app is not set up yet');
    return githubApp(config.github, doFetch);
  }

  /** Adds the modules a repository's tags name and the project does not have yet. */
  async function importModules(projectId: string, modules: Record<string, string[]>, by: string, byUser: string | null) {
    const imported: string[] = [];
    for (const [name, versions] of Object.entries(modules)) {
      const record = recordFromTags(name, versions);
      if (!record) continue;
      const entry: AuditEntry = { module: name, at: record.updatedAt, action: 'create', from: null, to: record.current, by };
      if (await store.createModule(projectId, fromRecord(record), entry, byUser)) imported.push(name);
    }
    return imported;
  }

  async function githubInstall(s: Session, projectId: string): Promise<Response> {
    const app = github();
    const state = await sign({ uid: s.uid, project: projectId } satisfies GithubState, config.sessionSecret, GITHUB_STATE_TTL);
    return redirect(app.installUrl(state));
  }

  async function githubCallback(request: Request, url: URL): Promise<Response> {
    const app = github();
    const s = await session(request);
    const state = await verify<GithubState>(url.searchParams.get('state') ?? undefined, config.sessionSecret);
    if (!s || !state || state.uid !== s.uid) return redirect('/app?github=expired');
    const back = (result: string) => redirect(`/app?project=${encodeURIComponent(state.project)}&github=${result}`);
    if (!(await store.getProject(s.uid, state.project))) return redirect('/app?github=expired');

    const code = url.searchParams.get('code');
    const installationId = Number(url.searchParams.get('installation_id'));
    if (!code || !Number.isSafeInteger(installationId) || installationId <= 0) return back('cancelled');
    if (!(await app.userHasInstallation(code, installationId))) return back('denied');

    const repos = await app.repositories(installationId);
    const repo = repos.length === 1 ? repos[0]! : null;
    await store.setGithub(s.uid, state.project, { installationId, repo });
    if (!repo) return back('choose');
    await importModules(state.project, await app.moduleVersions(installationId, repo), s.name ?? s.email ?? 'GitHub', s.uid);
    return back('connected');
  }

  async function githubProject(s: Session, projectId: string, request: Request): Promise<Response> {
    const method = request.method;
    if (method === 'DELETE') {
      await store.setGithub(s.uid, projectId, null);
      return new Response(null, { status: 204 });
    }
    const link = await store.getGithub(s.uid, projectId);
    if (method === 'GET') {
      if (!link) return json({ github: null, repos: [] });
      return json({ github: link, repos: await github().repositories(link.installationId) });
    }
    if (method === 'PUT') {
      if (!link) throw new HttpError(409, 'Install the GitHub app for this project first');
      const wanted = (await body(request)).repo;
      if (typeof wanted !== 'string' || !REPO.test(wanted)) throw new HttpError(400, 'repo must be owner/name');
      const app = github();
      const repo = (await app.repositories(link.installationId)).find((r) => r.toLowerCase() === wanted.toLowerCase());
      if (!repo) throw new HttpError(400, `The GitHub app cannot see ${wanted}`);
      const next = { installationId: link.installationId, repo };
      await store.setGithub(s.uid, projectId, next);
      const imported = await importModules(projectId, await app.moduleVersions(link.installationId, repo), s.name ?? s.email ?? 'GitHub', s.uid);
      return json({ github: next, imported });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  async function githubWebhook(request: Request): Promise<Response> {
    if (!config.github) throw new HttpError(503, 'The GitHub app is not set up yet');
    const raw = new Uint8Array(await request.arrayBuffer());
    const ok = await verifyWebhookSignature(config.github.webhookSecret, raw, request.headers.get('x-hub-signature-256'));
    if (!ok) throw new HttpError(401, 'Bad signature');
    let payload: any;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new HttpError(400, 'Send a JSON object');
    }
    const event = request.headers.get('x-github-event');
    const installationId = Number(payload?.installation?.id);

    if (event === 'installation' && payload.action === 'deleted' && installationId > 0) {
      return json({ cleared: await store.clearInstallation(installationId) }, 202);
    }
    if (event === 'create' && payload.ref_type === 'tag' && installationId > 0) {
      const tag = parseModuleTag(String(payload.ref ?? ''));
      const repo = String(payload.repository?.full_name ?? '');
      if (!tag || !isStable(tag.version) || !REPO.test(repo)) return json({ ignored: true }, 202);
      const created: string[] = [];
      for (const projectId of await store.projectsForRepo(installationId, repo)) {
        const done = await importModules(projectId, { [tag.module]: [tag.version] }, 'GitHub', null);
        if (done.length) created.push(projectId);
      }
      return json({ module: tag.module, version: tag.version, projects: created.length }, 202);
    }
    return json({ ignored: true }, 202);
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const method = request.method;

    if (url.pathname === CALLBACK && method === 'GET') return callback(request, url);
    if (url.pathname === GITHUB_CALLBACK && method === 'GET') return githubCallback(request, url);
    // GitHub signs its webhooks, so this sits before the session and Origin checks.
    if (url.pathname === '/api/github/webhook' && method === 'POST') return githubWebhook(request);
    if (url.pathname === '/api/auth/login' && method === 'GET') return login(url);
    if (url.pathname === '/api/auth/logout' && method === 'POST') {
      return json({ ok: true }, 200, { 'set-cookie': cookie(SESSION, '', '/', 0) });
    }
    if (url.pathname === '/api/me' && method === 'GET') {
      // 200 with a null user when signed out, so the app can ask without a console error.
      const s = await session(request);
      return json({ user: s ? { id: s.uid, name: s.name, email: s.email } : null });
    }

    if (parts[0] === 'api' && parts[1] === 'records' && parts.length === 4 && method === 'GET') {
      try {
        return await publicRecord(parts[2], parts[3]);
      } catch (error) {
        console.error(error);
        return json({ error: 'Something went wrong' }, 500, { 'access-control-allow-origin': '*' });
      }
    }

    if (parts[0] === 'api' && parts[1] === 'deploy') return deploy(request, parts);

    if (parts[0] !== 'api' || parts[1] !== 'projects') throw new HttpError(404, 'Not found');
    const s = await requireSession(request);
    const [, , id, sub, moduleName, action, extra] = parts;

    if (!id) {
      if (method === 'GET') return json({ projects: await store.listProjects(s.uid) });
      if (method === 'POST') {
        const p = await store.createProject(s.uid, projectName((await body(request)).name));
        return json({ project: p, modules: [] }, 201);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    const p = await project(s, id);
    if (!sub) {
      if (method === 'GET') return json({ project: p, modules: await store.listModules(p.id) });
      if (method === 'PATCH') {
        const renamed = await store.renameProject(s.uid, p.id, projectName((await body(request)).name));
        return json({ project: renamed });
      }
      if (method === 'DELETE') {
        await store.deleteProject(s.uid, p.id);
        return new Response(null, { status: 204 });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (sub === 'github' && !moduleName) return githubProject(s, p.id, request);
    if (sub === 'posthog' && !moduleName) return posthogProject(s, p.id, request);
    const kind = Object.hasOwn(KEY_ROUTE, sub) ? KEY_ROUTE[sub] : undefined;
    if (kind && !moduleName) return keyProject(s, p.id, kind, method);
    if (sub === 'github' && moduleName === 'install' && !action && method === 'GET') return githubInstall(s, p.id);
    if (sub === 'history' && !moduleName && method === 'GET') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
      return json({ history: await store.listHistory(p.id, limit) });
    }
    if (sub === 'modules' && !moduleName && method === 'POST') return createModule(s, p.id, request);
    if (sub === 'modules' && moduleName && action && !extra && method === 'POST') {
      return changeModule(s, p.id, moduleName, action, request);
    }
    throw new HttpError(404, 'Not found');
  }

  return async function handle(request: Request): Promise<Response> {
    try {
      return await route(request);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      if (error instanceof VersimoError) return json({ error: error.message }, 400);
      console.error(error);
      return json({ error: 'Something went wrong' }, 500);
    }
  };
}
