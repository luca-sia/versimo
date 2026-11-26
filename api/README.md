# versimo-api

The API behind [versimo.dev/app](https://versimo.dev/app). A Cloudflare Worker on the same zone as the site Worker (`versimo-site`). It owns these paths:

- `versimo.dev/api/*`
- `versimo.dev/app/callback`
- `versimo.dev/app/github/callback`

The site Worker keeps serving everything else.

It signs people in through Lucasia ID, the issuer at `https://lucasia.ai/api/auth` (OpenID Connect, authorisation code with PKCE, state and nonce, the ID token checked against the issuer's published keys) and keeps their projects, modules and history in Postgres 18. Module changes go through the Versimo library itself (`draftNext`, `promote`, `rollback`, `setRollout`, `validateRecord`), so the app and the library follow the same rules.

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
| `GET /api/projects/:id/github/install` | Starts installing the GitHub app for this project. Redirects to GitHub |
| `GET /app/github/callback` | Back from GitHub. Checks the installer, connects the repo and goes back to `/app?project=:id&github=connected` (or `choose`, `cancelled`, `denied`, `expired`) |
| `GET /api/projects/:id/github` | `{ github: { installationId, repo } \| null, repos }`, the repos the installation can see |
| `PUT /api/projects/:id/github` `{ repo }` | Connect one of those repos and add its modules from tags |
| `DELETE /api/projects/:id/github` | Disconnect |
| `POST /api/github/webhook` | GitHub events, checked by signature. A new stable `module/vX.Y.Z` tag adds that module to every project connected to the repo. Uninstalling the app disconnects its projects |

Every write needs the session cookie and `Origin: https://versimo.dev`, except the webhook, which GitHub signs. A project that belongs to someone else answers 404.

## GitHub app

Connecting a repo goes through the Versimo GitHub app, with "Request user authorization (OAuth) during installation" on. GitHub sends the person back to `/app/github/callback` with a code and an installation id. The id in that URL could be forged, so the Worker swaps the code for the person's own token and checks that they can see that installation before it saves anything.

Modules come from tags. When a repo is connected, every module with a stable `module/vX.Y.Z` tag that the project does not have yet is added, with current as the newest stable version and last the one before. After that a new module's first stable tag adds it. Tags never change a module that exists: drafting next stays a choice. The GitHub routes answer 503 until the six `GITHUB_*` settings are set. See [docs/github-app.md](../docs/github-app.md).

## Data

`migrations/0001_init.sql` has four tables: `users`, `projects`, `modules` (last, current, next, rollout, healthy) and `history`, which only ever gets new rows. `projects` also has `github_installation_id` and `github_repo` for the GitHub app.

## Tests

    npm ci
    npm test                       # the app and the in-memory store
    DATABASE_URL=postgres://... npm test   # also the Postgres store, on an empty database

CI runs both, the second against Postgres 18.

## First deploy

These steps change credentials or spend, so they wait for Catalin.

1. **The client.** Lucasia ID has a confidential client called Versimo: redirect URI `https://versimo.dev/app/callback`, scopes `openid profile email`, PKCE required, `client_secret_basic`. Its id is `CLIENT_ID` in `wrangler.jsonc` and its secret is in 1Password, `LUCASIA/versimo-production`.
2. **Make the database.** On the Postgres 18 server, create a `versimo` database and a `versimo_app` role that owns it, then run the migration:

       psql "postgres://versimo_app:...@host:5432/versimo" -f migrations/0001_init.sql

   Put the connection string in the same 1Password item.
3. **Connect the Worker to it.** `npx wrangler hyperdrive create versimo-db --connection-string="postgres://..."`, then put the id it prints in `wrangler.jsonc`.
4. **Set the secrets.**

       npx wrangler secret put CLIENT_SECRET
       npx wrangler secret put SESSION_SECRET    # openssl rand -base64 48

5. **Register the GitHub app** from [`github-app/manifest.json`](../github-app/manifest.json), as in [docs/github-app.md](../docs/github-app.md). Put the app id and client id in `vars` (`GITHUB_APP_ID`, `GITHUB_CLIENT_ID`) and the rest as secrets:

       npx wrangler secret put GITHUB_CLIENT_SECRET
       npx wrangler secret put GITHUB_APP_PRIVATE_KEY
       npx wrangler secret put GITHUB_WEBHOOK_SECRET

6. **Deploy.** `npm run deploy`. Then deploy the site with the app change that calls this API.

Done when you sign in on versimo.dev/app, add a project and it is still there after a refresh.
