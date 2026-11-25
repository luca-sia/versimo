# versimo-api

The API behind [versimo.dev/app](https://versimo.dev/app). A Cloudflare Worker on the same zone as the site Worker (`versimo-site`). It owns two kinds of path:

- `versimo.dev/api/*`
- `versimo.dev/app/callback`

The site Worker keeps serving everything else.

It signs people in through accounts.lucasia.ai (OpenID Connect, authorisation code with PKCE) and keeps their projects, modules and history in Postgres 18. Module changes go through the Versimo library itself (`draftNext`, `promote`, `rollback`, `setRollout`, `validateRecord`), so the app and the library follow the same rules.

## Endpoints

| Method and path | What it does |
| --- | --- |
| `GET /api/auth/login?return=/app` | Starts sign in. Redirects to the issuer |
| `GET /app/callback` | Finishes sign in. Sets the session cookie, then goes back to `return` |
| `POST /api/auth/logout` | Clears the session |
| `GET /api/me` | The signed in person, or `{ "user": null }` |
| `GET /api/projects` | Your projects |
| `POST /api/projects` `{ name }` | New project |
| `GET /api/projects/:id` | The project and its modules |
| `PATCH /api/projects/:id` `{ name }` | Rename |
| `DELETE /api/projects/:id` | Delete, with its modules and history |
| `POST /api/projects/:id/modules` `{ module, current, last? }` | New module |
| `POST /api/projects/:id/modules/:module/draft` `{ version, patch? }` | Draft next at 0% |
| `POST /api/projects/:id/modules/:module/rollout` `{ rollout }` | Share of users on next, 0 to 100 |
| `POST /api/projects/:id/modules/:module/promote` | Next to current, current to last |
| `POST /api/projects/:id/modules/:module/rollback` | Last back to current |
| `GET /api/projects/:id/history?limit=50` | The audit trail, newest first |

Every write needs the session cookie and `Origin: https://versimo.dev`. A project that belongs to someone else answers 404.

## Data

`migrations/0001_init.sql` has four tables: `users`, `projects`, `modules` (last, current, next, rollout, healthy) and `history`, which only ever gets new rows. `projects` also has `github_installation_id` and `github_repo` for the GitHub app.

## Tests

    npm ci
    npm test                       # the app and the in-memory store
    DATABASE_URL=postgres://... npm test   # also the Postgres store, on an empty database

CI runs both, the second against Postgres 18.

## First deploy

These steps change credentials or spend, so they wait for Catalin.

1. **Register the client.** On accounts.lucasia.ai, add a confidential client called Versimo with the redirect URI `https://versimo.dev/app/callback` and the scopes `openid profile email`. If the client id is not `versimo`, change `CLIENT_ID` in `wrangler.jsonc`. Put the client id and secret in 1Password, `LUCASIA/versimo-production`.
2. **Make the database.** On the Postgres 18 server, create a `versimo` database and a `versimo_app` role that owns it, then run the migration:

       psql "postgres://versimo_app:...@host:5432/versimo" -f migrations/0001_init.sql

   Put the connection string in the same 1Password item.
3. **Connect the Worker to it.** `npx wrangler hyperdrive create versimo-db --connection-string="postgres://..."`, then put the id it prints in `wrangler.jsonc`.
4. **Set the secrets.**

       npx wrangler secret put CLIENT_SECRET
       npx wrangler secret put SESSION_SECRET    # openssl rand -base64 48

5. **Deploy.** `npm run deploy`. Then deploy the site with the app change that calls this API.

Done when you sign in on versimo.dev/app, add a project and it is still there after a refresh.
