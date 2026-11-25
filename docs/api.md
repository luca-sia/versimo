# API reference

Everything is a named export of `@versimo/sdk`.

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

### `setRollout(record, n, opts?)`

Sets `rollout` to `n`, an integer from 0 to 100. Throws when `n` is above 0 and `next` is null.

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
}
```

Returns a `VersimoClient`:

- `record(module)` returns the cached or freshly loaded, validated record.
- `resolve(module, ctx?)` returns a `Resolution`.
- `version(module, ctx?)` returns the version string.
- `clear(module?)` drops one cached record, or all.

Concurrent loads of one module share a single request. If a refresh fails with a source error and a stale record exists, the stale record is returned.

Module slugs must match `^[a-z0-9]+(-[a-z0-9]+)*$`.

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
