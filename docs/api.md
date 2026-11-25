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

### `setRollout(record, n, opts?)`

Sets `rollout` to `n`, an integer from 0 to 100. Throws when `n` is above 0 and `next` is null.

## Validating

### `validateRecord(record)`

Returns `{ ok: boolean, errors: string[] }`. It never throws. It checks every field, rejects unknown fields, and checks that `next` is above `current`, `last` is below `current`, and `rollout` is 0 when there is no next.

## Health and automatic rollback

### `evaluateHealth(samples, thresholds?)`

Pure. Returns `{ healthy: boolean, reasons: string[] }`.

```ts
interface HealthSamples {
  requests: number;
  errors: number;
  p95Ms?: number;
  checks?: { name: string; ok: boolean }[];
}
interface HealthThresholds {
  maxErrorRate?: number; // 0 to 1, default 0.05
  maxP95Ms?: number;     // not judged when unset
  minRequests?: number;  // default 20
}
```

The error rate is judged only when `requests` is at least `minRequests`, and it fails when it is above `maxErrorRate`. Latency fails when `p95Ms` is above `maxP95Ms`. Every failed custom check counts, whatever the request volume. Throws `INVALID_INPUT` when `maxErrorRate` is outside 0 to 1.

### `checkUrl(url, opts?)`

Returns `{ name: url, ok }`, with `ok` true only for a 2xx response within `timeoutMs` (default 5000). It never throws. A network error, a timeout, a redirect or a non-2xx status gives `ok: false`. Pass `fetch` to replace `globalThis.fetch`. The result fits straight into `samples.checks`.

### `applyHealth(record, result, options?)`

Returns a new record and never changes the one you pass in. `options` takes the same `by` and `now` as the transitions, plus `onAlert`.

- Healthy result: returns the record as it is. It does not set `healthy` back to true. A promote or a rollback does that.
- Unhealthy result with a `last`: calls `rollback`, so the result is exactly what `rollback` gives. Current becomes last, last and next become null, rollout becomes 0 and `healthy` becomes true on the restored version. The history entry has action `rollback` and `by` set to `options.by`, or `versimo-health` when not given.
- Unhealthy result with no `last`: sets `healthy` to false and leaves everything else alone. Users stay on current, because there is nothing better to serve, and the resolution reason is `UNHEALTHY`. The history entry has action `rollback`, `from` set to current and `to` set to null, which reads as a step back that had nowhere to go. A record that is already unhealthy is returned unchanged.
- `onAlert({ module, action, reasons })` is called once, and only when the record changed. `action` is `rollback` or `unhealthy`.

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
