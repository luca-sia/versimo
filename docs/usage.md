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

## PostHog flags as a source

You can keep records in PostHog as the JSON payload of a feature flag. Versimo does the bucketing, so set the PostHog flag itself to 100% rollout and use it only to carry the record.

```ts
import { PostHog } from 'posthog-node';
import { createClient, type ModuleRecord } from 'versimo';

const posthog = new PostHog(process.env.POSTHOG_API_KEY!);

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

## Health checks

Your monitoring decides when current is unhealthy. When it does, write the record with `healthy: false`. Users get last at once. Then call `rollback` to make it permanent, and ship the fix as a patch.

```ts
import { rollback } from 'versimo';

await store.save({ ...record, healthy: false });
// later, once you have decided
await store.save(rollback(record, { by: 'health-check' }));
```
