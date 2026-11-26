import postgres from 'postgres';

import { createApp } from './app.js';
import { createOidc, type Oidc } from './oidc.js';
import { PgStore } from './pg-store.js';

export interface Env {
  HYPERDRIVE: { connectionString: string };
  ISSUER: string;
  CLIENT_ID: string;
  APP_ORIGIN: string;
  CLIENT_SECRET: string;
  SESSION_SECRET: string;
  /** The GitHub app. All six are needed. Until then the GitHub routes answer 503. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
}

function githubConfig(env: Env) {
  const { GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET } = env;
  if (!GITHUB_APP_ID || !GITHUB_APP_SLUG || !GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET || !GITHUB_APP_PRIVATE_KEY || !GITHUB_WEBHOOK_SECRET) {
    return undefined;
  }
  return {
    appId: GITHUB_APP_ID,
    slug: GITHUB_APP_SLUG,
    clientId: GITHUB_CLIENT_ID,
    clientSecret: GITHUB_CLIENT_SECRET,
    privateKey: GITHUB_APP_PRIVATE_KEY,
    webhookSecret: GITHUB_WEBHOOK_SECRET,
  };
}

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

const doFetch: typeof fetch = (input, init) => fetch(input, init);
let kept: { issuer: string; oidc: Oidc } | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    // Hyperdrive pools the connections, so one client per request is cheap.
    const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
    if (kept?.issuer !== env.ISSUER) kept = { issuer: env.ISSUER, oidc: createOidc(env.ISSUER, doFetch) };
    const app = createApp({
      oidc: kept.oidc,
      fetch: doFetch,
      store: new PgStore(sql),
      config: {
        issuer: env.ISSUER,
        clientId: env.CLIENT_ID,
        clientSecret: env.CLIENT_SECRET,
        sessionSecret: env.SESSION_SECRET,
        appOrigin: env.APP_ORIGIN,
        github: githubConfig(env),
      },
    });
    try {
      return await app(request);
    } finally {
      ctx.waitUntil(sql.end());
    }
  },
};
