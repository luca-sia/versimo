# API reference

Everything is a named export of `versimo`.

## Types

```ts
type Action = 'draft' | 'promote' | 'rollback' | 'rollout' | 'patch';

interface HistoryEntry {
  at: string;
  action: Action;
  from: string | null;
  to: string | null;
  by?: string;
}

interface ModuleRecord {
  $schema?: string;
  module: string;
  last: string | null;
  current: string;
  next: string | null;
  rollout: number;
  healthy: boolean;
  updatedAt: string;
  history?: HistoryEntry[];
}

interface Context { userId?: string }
type Channel = 'next' | 'current' | 'last';
type ResolutionReason = 'ROLLOUT' | 'DEFAULT' | 'NO_USER' | 'UNHEALTHY';

interface Resolution {
  version: string;
  channel: Channel;
  reason: ResolutionReason;
  bucket: number | null;
}

interface TransitionOptions {
  by?: string;                     // recorded in history
  now?: Date | string | number;    // defaults to now
}
```

## Resolving

### `resolveVersion(record, ctx?)`

Returns the version string this user should get.

1. If `record.healthy` is false, return `last`, or `current` when there is no last.
2. If there is no `ctx.userId`, return `current`.
3. If `next` is set and the user's bucket is below `rollout`, return `next`.
4. Otherwise return `current`.

### `resolve(record, ctx?)`

Same rules, but returns a `Resolution` with the channel, the reason and the bucket.

### `bucketFor(module, userId)`

Returns the user's bucket, an integer from 0 to 99. Stable for a given module and user id.

## Changing a record

All four return a new record and never change the one you pass in. Each sets `updatedAt` and appends a history entry. They throw a `VersimoError` with code `INVALID_INPUT` when the change makes no sense.

### `draftNext(record, version, opts?)`

Sets `next` to `version` and `rollout` to 0. Replaces any next already there. `version` must be valid semver and greater than `current`. Pass `{ patch: true }` to log the action as `patch` instead of `draft`.

### `promote(record, opts?)`

Moves `next` to `current` and `current` to `last`. Empties `next`, sets `rollout` to 0 and `healthy` to true. Throws when `next` is null.

### `rollback(record, opts?)`

Sets `current` to `last`. Sets `last` and `next` to null, `rollout` to 0 and `healthy` to true. Throws when `last` is null.

All four take `opts.by` and `opts.reason`, which are written to the history entry.

### `setRollout(record, n, opts?)`

Sets `rollout` to `n`, an integer from 0 to 100. Throws when `n` is above 0 and `next` is null.

## Health

### `evaluateHealth(checks, observation)`

Judges one observation against the checks and returns `{ healthy, failures }`. Each failure is `{ check, value, limit }`, with `check` one of `errorRate`, `latency` or `url`, in that order. Throws `INVALID_INPUT` for a bad limit or a bad measurement.

### `checkHealth(record, checks, observation, opts?)`

Runs `evaluateHealth`. When current fails and there is a last, it returns the rolled back record with `rolledBack: true`. The history entry has `by` (default `versimo-health`) and `reason`, for example `health: errorRate, latency`. With no last the record comes back unchanged. Returns `{ record, verdict, rolledBack }`.

### `createHealthMonitor(options)`

Runs the checks on its own: reads the record from your store, measures, rolls back, writes the record and alerts. `check(module)` runs once. `start(modules, everyMs?)` runs on a timer and returns a stop function. See [Health checks](health.md) for the options.

## Validating

### `validateRecord(record)`

Returns `{ ok: boolean, errors: string[] }`. It never throws. It checks every field, rejects unknown fields, and checks that `next` is above `current`, `last` is below `current`, and `rollout` is 0 when there is no next.

## Client

### `createClient(options)`

```ts
interface ClientOptions {
  source: ((module: string) => ModuleRecord | null | undefined | Promise<ModuleRecord | null | undefined>) | string;
  ttlMs?: number;            // default 30000
  now?: () => number;        // clock for the cache, for tests
  fetch?: typeof fetch;      // for URL sources
  rollout?: (module: string) => number | null | undefined | Promise<number | null | undefined>;
}
```

`rollout` overrides the record's share on next, for example with `postHogRollout`. Only the share changes. When it returns null, a value outside 0 to 100, or throws, the record's own rollout is used.

Returns a `VersimoClient`:

- `record(module)` returns the cached or freshly loaded, validated record, with any `rollout` override applied.
- `resolve(module, ctx?)` returns a `Resolution`.
- `version(module, ctx?)` returns the version string.
- `clear(module?)` drops one cached record, or all.

Concurrent loads of one module share a single request. If a refresh fails with a source error and a stale record exists, the stale record is returned.

Module slugs must match `^[a-z0-9]+(-[a-z0-9]+)*$`.

## PostHog

### `postHogRollout(options)`

```ts
interface PostHogRolloutOptions {
  apiKey: string;            // PostHog project key, phc_...
  host?: string;             // default https://eu.i.posthog.com
  ttlMs?: number;            // default 30000
  now?: () => number;
  fetch?: typeof fetch;
}
```

Returns a rollout function for `createClient`. It reads the flag `versimo-<module>` from one `/flags?v=2` request per TTL, sent with the distinct id `versimo` and no user data. See [PostHog flags drive next](usage.md#posthog-flags-drive-next).

### `rolloutFromFlag(flag)`

The share on next from one flag of a PostHog `/flags?v=2` answer, or null to keep the record's rollout. Flag off gives 0. Flag on with a payload whose `rollout` is a whole number from 0 to 100 gives that number. The payload may be a JSON string or an object.

### `postHogFlagKey(module)`

`versimo-<module>`.

## OpenFeature provider

### `new VersimoProvider(client)`

Has `metadata`, `resolveStringEvaluation`, and the boolean, number and object methods. See [usage](usage.md#openfeature).

```ts
resolveStringEvaluation(flagKey: string, defaultValue: string, context?: EvaluationContext):
  Promise<{ value: string; variant?: string; reason?: string; errorCode?: string; errorMessage?: string }>
```

`context.targetingKey` is used as the user id.

## Semver helpers

- `isSemver(value)` returns true for a valid semver string.
- `parseSemver(value)` returns `{ major, minor, patch, prerelease }` or throws a `TypeError`.
- `compareSemver(a, b)` returns -1, 0 or 1. Prerelease rules follow the spec. Build metadata is ignored.
- `SEMVER_PATTERN` is the regular expression source, the same one the JSON Schema uses.

## Errors

### `VersimoError`

An `Error` with a `code`.

| Code | When |
| --- | --- |
| `INVALID_INPUT` | A bad argument, such as a bad version, a bad rollout or a bad module slug |
| `INVALID_RECORD` | A fetched record failed `validateRecord` |
| `NOT_FOUND` | The source has no record for the module |
| `SOURCE_ERROR` | The source threw, or the HTTP request failed |
