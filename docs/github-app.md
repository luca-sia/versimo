# GitHub app

The Versimo GitHub app connects a repository to a Versimo project. It does two things and no more:

1. It reads the repository's tags to find your modules and their versions.
2. It opens pull requests for drafts and patches, with auto merge turned on, so they merge once your checks are green.

It never pushes to `main`. Every change arrives as a normal pull request that your branch rules and reviews apply to.

## Modules and versions come from tags

Tag each release of a module as `module/vX.Y.Z`:

```sh
git tag -s billing/v2.4.0 -m "billing 2.4.0"
git push origin billing/v2.4.0
```

The module is a lower-case slug, the same rule as the record's `module` field. Other tags, such as `v1.0.0` or `packages/go/v0.2.0`, are ignored.

For a module with no record yet, Versimo starts one from its tags: current is the newest stable version, last is the one before it, next is empty and rollout is 0. Pre-release tags such as `billing/v2.5.0-rc.1` are listed but never become current on their own. You choose when to draft next.

## Permissions

| Permission | Level | Why |
| --- | --- | --- |
| Metadata | Read | Required by GitHub for every app |
| Contents | Write | Read code and tags, and create the branch a pull request comes from |
| Pull requests | Write | Open pull requests and turn on auto merge |

Events: `create`, `delete` and `push` (tags appear and go away), and `pull_request` (a draft or patch merged or closed).

GitHub has no permission for "create branches but not push to main". Contents write is the narrowest level that lets an app open a pull request from its own branch. Versimo keeps the promise in two ways:

- **In the code.** The client in `versimo/github` has exactly one write: it creates a new branch from the base, commits to it and opens a pull request. It creates refs and never updates or deletes one, and it refuses a head branch named `main`, `master`, the default branch or the base. There is no code path that moves an existing branch.
- **In your repository.** Add a branch ruleset on your default branch that requires a pull request before merging. Then no app, Versimo included, can push to it directly.

Auto merge needs "Allow auto-merge" on in the repository's settings. When it is off, the pull request still opens and Versimo tells you auto merge could not be turned on.

## Using it from code

The pieces the Versimo app uses are in the library, under `versimo/github`. They use `fetch` and WebCrypto only, so they run on Node 20, Cloudflare Workers and Deno.

```ts
import { createAppJwt, getInstallationToken, createGitHub, recordFromTags } from 'versimo/github';

const jwt = await createAppJwt({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY });
const { token } = await getInstallationToken({ jwt, installationId });
const github = createGitHub({ token });

const modules = await github.moduleVersions('acme', 'shop');
// { billing: ['2.4.0', '2.3.1'], search: ['1.0.0'] }
const record = recordFromTags('billing', modules.billing!);

const pr = await github.openPullRequest({
  owner: 'acme',
  repo: 'shop',
  head: 'versimo/billing-v2.4.1',
  title: 'billing 2.4.1',
  files: [{ path: 'src/billing/fix.ts', content: '...' }],
});
// { number: 7, url: '...', autoMerge: true }
```

Check webhooks before you trust them:

```ts
import { verifyWebhookSignature } from 'versimo/github';

const body = await request.text();
if (!(await verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get('x-hub-signature-256')))) {
  return new Response('bad signature', { status: 401 });
}
```

## Registering the app

This is done once, by the owner of the `luca-sia` organisation. The manifest is in [`github-app/manifest.json`](../github-app/manifest.json).

1. Open `https://github.com/organizations/luca-sia/settings/apps/new` and register the app from the manifest (GitHub's [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)), or fill in the same values by hand.
2. Generate a private key and a webhook secret.
3. Save the app id, client id, private key and webhook secret in 1Password, never in the repository.
4. Give them to the API Worker as secrets: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET`.

The webhook and callback URLs in the manifest point at `versimo.dev`. Change them there first if the API Worker lives somewhere else.
