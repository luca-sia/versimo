# Usage

## Server

```ts
import { createClient } from '@versimo/sdk';

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

The SDK uses only `fetch`, `TextEncoder` and standard built-ins.

```ts
import { createClient } from '@versimo/sdk';

const versimo = createClient({ source: '/versimo' });
const version = await versimo.version('search', { userId: currentUserId });
```

Use a stable id. A signed-in user id is best. For anonymous visitors, store a random id in a cookie or local storage and reuse it, or they will move between versions.

## React

```tsx
import { useEffect, useState } from 'react';
import { createClient } from '@versimo/sdk';

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

## OpenFeature

`VersimoProvider` follows the shape of an OpenFeature server provider. It imports nothing from OpenFeature, so the SDK stays free of dependencies. The flag key is the module slug and the value is the version string.

```ts
import { OpenFeature } from '@openfeature/server-sdk';
import { createClient, VersimoProvider } from '@versimo/sdk';

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

The default value you pass is returned on errors. Boolean, number and object evaluations return `TYPE_MISMATCH`. The provider is asynchronous, so it fits the server SDK. The web SDK expects synchronous providers, so in browsers use the client directly.

If your installed OpenFeature version types the provider differently, the provider still works at runtime. A small cast is enough.

## PostHog flags as a source

You can keep records in PostHog as the JSON payload of a feature flag. Versimo does the bucketing, so set the PostHog flag itself to 100% rollout and use it only to carry the record.

```ts
import { PostHog } from 'posthog-node';
import { createClient, type ModuleRecord } from '@versimo/sdk';

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
import { promote } from '@versimo/sdk';

const record = await versimo.record('billing');
await store.save(promote(record, { by: 'alex' }));
versimo.clear('billing'); // make this process see it at once
```

Other processes see the change after their cache expires.

## Health checks

Your monitoring decides when current is unhealthy. When it does, write the record with `healthy: false`. Users get last at once. Then call `rollback` to make it permanent, and ship the fix as a patch.

```ts
import { rollback } from '@versimo/sdk';

await store.save({ ...record, healthy: false });
// later, once you have decided
await store.save(rollback(record, { by: 'health-check' }));
```
