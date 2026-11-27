# Usage

## Server

```ts
import { createClient } from 'versimo';

const versimo = createClient({
  source: 'https://config.example.com/versimo',
  ttlMs: 15_000,
});

app.get('/checkout', async (req, res) => {
  const version = await versimo.version('billing', { userId: req.user.id });
  res.json(await loadBilling(version));
});
```

A URL source fetches `<base>/<module>.json`. Use `{module}` in the URL to control the shape, for example `https://config.example.com/api?m={module}`.

A source can also be a function. It receives the module slug and returns a record, or a promise of one.

```ts
const versimo = createClient({
  source: async (module) => db.versimoRecords.findOne({ module }),
});
```

Records are checked with `validateRecord` when fetched. An invalid record throws a `VersimoError` with code `INVALID_RECORD`. Records are cached for `ttlMs` (30 seconds by default). If the source fails after the cache expires, the client serves the stale record instead of failing.

## Browser

Versimo uses only `fetch`, `TextEncoder` and standard built-ins.

```ts
import { createClient } from 'versimo';

const versimo = createClient({ source: '/versimo' });
const version = await versimo.version('search', { userId: currentUserId });
```

Use a stable id. A signed-in user id is best. For anonymous visitors, store a random id in a cookie or local storage and reuse it, or they will move between versions.

## React

```tsx
import { useEffect, useState } from 'react';
import { createClient } from 'versimo';

const versimo = createClient({ source: '/versimo' });

export function useModuleVersion(module: string, userId: string) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    versimo.version(module, { userId }).then((v) => live && setVersion(v));
    return () => {
      live = false;
    };
  }, [module, userId]);
  return version;
}

export function Billing({ userId }: { userId: string }) {
  const version = useModuleVersion('billing', userId);
  if (version === null) return null;
  return version.startsWith('2.5.') ? <BillingNext /> : <BillingCurrent />;
}
```

## React Native

Versimo works in React Native as it is. It uses `fetch` and standard built-ins. The bucket needs UTF-8 bytes, so it uses `TextEncoder` when the engine has it (Hermes does from React Native 0.74) and a small built-in encoder when it does not. Both give the same buckets.

Use a stable id. Store a random id for anonymous users, for example with AsyncStorage, and reuse it.

```tsx
import { useEffect, useState } from 'react';
import { createClient } from 'versimo';

const versimo = createClient({ source: 'https://config.example.com/versimo' });

export function useModuleVersion(module: string, userId: string) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    versimo
      .version(module, { userId })
      .then((v) => live && setVersion(v))
      .catch(() => live && setVersion(null));
    return () => {
      live = false;
    };
  }, [module, userId]);
  return version;
}

export function Checkout({ userId }: { userId: string }) {
  const version = useModuleVersion('checkout', userId);
  if (version === null) return <CheckoutCurrent />;
  return version.startsWith('3.1.') ? <CheckoutNext /> : <CheckoutCurrent />;
}
```

Fall back to your current screen while the version loads or when the request fails. On a native app you ship every version inside the binary, so the version string picks between code you already have. It cannot download new code.

## OpenFeature

`VersimoProvider` follows the shape of an OpenFeature server provider. It imports nothing from OpenFeature, so Versimo stays free of dependencies. The flag key is the module slug and the value is the version string.

```ts
import { OpenFeature } from '@openfeature/server-sdk';
import { createClient, VersimoProvider } from 'versimo';

const client = createClient({ source: 'https://config.example.com/versimo' });
await OpenFeature.setProviderAndWait(new VersimoProvider(client));

const flags = OpenFeature.getClient();
const version = await flags.getStringValue('billing', '2.4.0', { targetingKey: 'user-42' });
```

| Versimo result | Variant | Reason |
| --- | --- | --- |
| User is inside the rollout | `next` | `SPLIT` |
| User is outside the rollout, or has no targeting key | `current` | `STATIC` |
| Current is unhealthy | `last` | `DISABLED` |
| Module not found | none | `ERROR` with `FLAG_NOT_FOUND` |
| Source failed | none | `ERROR` with `GENERAL` |

The default value you pass is returned on errors. Boolean, number and object evaluations return `TYPE_MISMATCH`. The provider is asynchronous, so it fits the OpenFeature server package. The OpenFeature web package expects synchronous providers, so in browsers use the client directly.

If your installed OpenFeature version types the provider differently, the provider still works at runtime. A small cast is enough.

## PostHog flags drive next

PostHog can hold the share of users on next for each module, so a rollout change needs no deploy and no record write. Versimo still does the bucketing: PostHog says how many users get next, `bucketFor` says which ones. A user lands on the same version in every language, with or without PostHog.

Set up one PostHog flag per module:

- Key `versimo-<module>`, for example `versimo-billing`.
- Release condition 100% of users. Do not use PostHog's own percentage.
- Payload `{"rollout": 25}`, a whole number from 0 to 100.

```ts
import { createClient, postHogRollout } from 'versimo';

const versimo = createClient({
  source: 'https://example.com/versimo/',
  rollout: postHogRollout({
    apiKey: process.env.POSTHOG_PROJECT_KEY!, // phc_..., the public project key
    host: 'https://eu.i.posthog.com',          // the default, or https://us.i.posthog.com for US projects
  }),
});
```

How the flag is read:

| PostHog | Share on next |
| --- | --- |
| Payload `{"rollout": n}` | n |
| Flag on, no usable payload | the record's `rollout` |
| Flag on but not served (off for the `versimo` id) | 0, everyone leaves next |
| Flag missing, disabled in PostHog, or PostHog down | the record's `rollout` |

Health always wins. When `healthy` is false users get last, whatever PostHog says.

One request to `/flags?v=2` serves every module, once per TTL (30 seconds by default). When PostHog cannot be reached the last good answer is kept, and with none the record's own rollout is used.

No user data goes to PostHog. The request carries only the project key and the fixed distinct id `versimo`. User ids stay in the app.

The same works in Python (`Client(source, rollout=PostHogRollout(api_key))`) and Go (`ClientOptions{Rollout: rollout}` with `NewPostHogRollout`).

You can also keep the whole record in the flag payload and use PostHog as the source. The `rollout` field of that record is read the same way.

```ts
import { PostHog } from 'posthog-node';
import { createClient, type ModuleRecord } from 'versimo';

const posthog = new PostHog(process.env.POSTHOG_PROJECT_KEY!);

const versimo = createClient({
  source: async (module) => {
    const payload = await posthog.getFeatureFlagPayload(`versimo-${module}`, 'versimo');
    return (payload ?? null) as ModuleRecord | null;
  },
});
```

Any store works the same way. Return the record, or null when the module does not exist.

## Updating records

The transition functions are pure. Read, change, write.

```ts
import { promote } from 'versimo';

const record = await versimo.record('billing');
await store.save(promote(record, { by: 'alex' }));
versimo.clear('billing'); // make this process see it at once
```

Other processes see the change after their cache expires.

## versimo.dev

A project on [versimo.dev/app](https://versimo.dev/app) keeps your records for you. It gives you two keys.

The read key only reads records. It is safe in a browser bundle:

```ts
const versimo = createClient({ source: `https://versimo.dev/api/records/${VERSIMO_READ_KEY}` });
```

The deploy key changes modules. Keep it in CI secrets. If your pipeline already ships next, promote and rollback, tell Versimo after each step:

```sh
npx versimo draft app 1.4.0      # next uploaded at 0%
npx versimo rollout app 10
npx versimo promote app
npx versimo rollback app         # after an automatic return to last
```

The command reads `VERSIMO_DEPLOY_KEY`. From code, use `createDeployClient({ key })`, which has the same calls.

## Health checks

Your monitoring decides when current is unhealthy. When it does, write the record with `healthy: false`. Users get last at once. Then call `rollback` to make it permanent, and ship the fix as a patch.

```ts
import { rollback } from 'versimo';

await store.save({ ...record, healthy: false });
// later, once you have decided
await store.save(rollback(record, { by: 'health-check' }));
```
