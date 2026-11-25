import {
  draftNext,
  promote,
  rollback,
  setRollout,
  validateRecord,
  VersimoError,
  type ModuleRecord,
} from '../../src/index.js';
import { cookie, pkceChallenge, randomToken, readCookie, sign, verify } from './session.js';
import type { AuditEntry, Store, StoredModule } from './store.js';

export interface Config {
  /** The OIDC issuer, https://accounts.lucasia.ai. */
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  clientId: string;
  clientSecret: string;
  /** At least 32 characters. Signs the session and sign in cookies. */
  sessionSecret: string;
  /** Where the app lives, https://versimo.dev. */
  appOrigin: string;
}

export interface Deps {
  store: Store;
  config: Config;
  fetch?: typeof fetch;
}

interface Session {
  uid: string;
  name: string | null;
  email: string | null;
}

interface SignIn {
  state: string;
  verifier: string;
  back: string;
}

const SESSION = 'versimo_session';
const SIGN_IN = 'versimo_signin';
const SESSION_TTL = 7 * 24 * 3600;
const SIGN_IN_TTL = 10 * 60;
const CALLBACK = '/app/callback';

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

const toRecord = (m: StoredModule): ModuleRecord => ({ ...m, history: [] });

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
    const verifier = randomToken(48);
    const back = safeBack(url.searchParams.get('return'));
    const target = new URL(config.authorizeUrl);
    target.search = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.appOrigin + CALLBACK,
      scope: 'openid profile email',
      state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
    }).toString();
    const signIn = await sign({ state, verifier, back } satisfies SignIn, config.sessionSecret, SIGN_IN_TTL);
    return redirect(target.toString(), [cookie(SIGN_IN, signIn, CALLBACK, SIGN_IN_TTL)]);
  }

  async function callback(request: Request, url: URL): Promise<Response> {
    const clear = cookie(SIGN_IN, '', CALLBACK, 0);
    if (url.searchParams.get('error')) return redirect('/app?signin=cancelled', [clear]);
    const signIn = await verify<SignIn>(readCookie(request, SIGN_IN), config.sessionSecret);
    const code = url.searchParams.get('code');
    if (!signIn || !code || url.searchParams.get('state') !== signIn.state) {
      return redirect('/app?signin=expired', [clear]);
    }

    const tokenResponse = await doFetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.appOrigin + CALLBACK,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: signIn.verifier,
      }),
    });
    if (!tokenResponse.ok) return redirect('/app?signin=failed', [clear]);
    const tokens = (await tokenResponse.json()) as { access_token?: unknown };
    if (typeof tokens.access_token !== 'string') return redirect('/app?signin=failed', [clear]);

    // Userinfo, called with the access token over TLS, is the identity we trust.
    const infoResponse = await doFetch(config.userinfoUrl, {
      headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' },
    });
    if (!infoResponse.ok) return redirect('/app?signin=failed', [clear]);
    const info = (await infoResponse.json()) as { sub?: unknown; email?: unknown; name?: unknown };
    if (typeof info.sub !== 'string' || info.sub === '') return redirect('/app?signin=failed', [clear]);

    const user = await store.upsertUser({
      issuer: config.issuer,
      subject: info.sub,
      email: typeof info.email === 'string' ? info.email : null,
      name: typeof info.name === 'string' ? info.name : null,
    });
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
    const ok = await store.createModule(projectId, fromRecord(record), entry, s.uid);
    if (!ok) throw new HttpError(409, `A module called ${record.module} already exists`);
    return json({ module: fromRecord(record) }, 201);
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
      s.uid,
    );
    if (!updated) throw new HttpError(404, 'No such module');
    return json({ module: updated });
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const method = request.method;

    if (url.pathname === CALLBACK && method === 'GET') return callback(request, url);
    if (url.pathname === '/api/auth/login' && method === 'GET') return login(url);
    if (url.pathname === '/api/auth/logout' && method === 'POST') {
      return json({ ok: true }, 200, { 'set-cookie': cookie(SESSION, '', '/', 0) });
    }
    if (url.pathname === '/api/me' && method === 'GET') {
      // 200 with a null user when signed out, so the app can ask without a console error.
      const s = await session(request);
      return json({ user: s ? { id: s.uid, name: s.name, email: s.email } : null });
    }

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
