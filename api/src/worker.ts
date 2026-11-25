import postgres from 'postgres';

import { createApp } from './app.js';
import { PgStore } from './pg-store.js';

export interface Env {
  HYPERDRIVE: { connectionString: string };
  ISSUER: string;
  CLIENT_ID: string;
  APP_ORIGIN: string;
  AUTHORIZE_URL?: string;
  TOKEN_URL?: string;
  USERINFO_URL?: string;
  CLIENT_SECRET: string;
  SESSION_SECRET: string;
}

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    // Hyperdrive pools the connections, so one client per request is cheap.
    const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
    const app = createApp({
      store: new PgStore(sql),
      config: {
        issuer: env.ISSUER,
        authorizeUrl: env.AUTHORIZE_URL ?? `${env.ISSUER}/api/auth/oauth2/authorize`,
        tokenUrl: env.TOKEN_URL ?? `${env.ISSUER}/api/auth/oauth2/token`,
        userinfoUrl: env.USERINFO_URL ?? `${env.ISSUER}/api/auth/oauth2/userinfo`,
        clientId: env.CLIENT_ID,
        clientSecret: env.CLIENT_SECRET,
        sessionSecret: env.SESSION_SECRET,
        appOrigin: env.APP_ORIGIN,
      },
    });
    try {
      return await app(request);
    } finally {
      ctx.waitUntil(sql.end());
    }
  },
};
