# Porting Versimo

Every language port must give the same answer as Versimo for TypeScript for the same record and user. A user must land on the same version whichever language the server or the app is written in. This page says what to copy and how to check it.

The reference is the TypeScript source in `src/`. The shared test data is [spec/vectors.json](../spec/vectors.json).

## What a port contains

- `bucketFor`
- `resolve` and `resolveVersion`
- `draftNext`, `promote`, `rollback` and `setRollout`
- `validateRecord`
- Semver check and compare
- A client with a source (a function, or a URL), a TTL cache and stale-on-error

A PostHog rollout source is optional. If a port has one, `rolloutFromFlag` must pass the `posthog` vectors, and the client applies the share to the record before resolving. PostHog only sets the share. The bucket always decides who is on next.

An OpenFeature provider is optional. Add it only when the language has a way to do it without a dependency.

## The bucket

```
bytes = UTF-8(module + "\0" + userId)
h = 0x811c9dc5
for each byte:
    h = h XOR byte
    h = (h * 0x01000193) mod 2^32
h = h XOR (h >> 16)
h = (h * 0x85ebca6b) mod 2^32
h = h XOR (h >> 13)
h = (h * 0xc2b2ae35) mod 2^32
h = h XOR (h >> 16)
bucket = h mod 100
```

All arithmetic is on unsigned 32-bit integers. The first part is FNV-1a. The rest is the murmur3 finaliser, which spreads the low bits so that `mod 100` is even.

Hash the bytes of the string as given. Do not normalise Unicode. Input must be valid Unicode, so lone surrogates are out of scope.

## Resolving

1. If `healthy` is false, return `last`, or `current` when there is no last. Reason `UNHEALTHY`, no bucket.
2. If the user id is missing or empty, return `current`. Reason `NO_USER`, no bucket.
3. Compute the bucket. If `next` is set and `bucket < rollout`, return `next` with reason `ROLLOUT`.
4. Otherwise return `current` with reason `DEFAULT`.

The channel is `next`, `current` or `last` to match the version returned.

## Transitions

Each transition returns a new record, sets `updatedAt` to the time of the change, and appends a history entry `{ at, action, from, to, by? }`. The time is written as UTC with milliseconds, for example `2026-04-01T10:00:00.000Z`. The input is never changed. Errors use the code `INVALID_INPUT`.

| Function | Changes | History action, from and to |
| --- | --- | --- |
| `draftNext(version)` | `next = version`, `rollout = 0` | `draft` (or `patch`), `next` or else `current`, version |
| `promote` | `last = current`, `current = next`, `next = null`, `rollout = 0`, `healthy = true` | `promote`, current, next |
| `rollback` | `last = null`, `current = last`, `next = null`, `rollout = 0`, `healthy = true` | `rollback`, current, last |
| `setRollout(n)` | `rollout = n` | `rollout`, old rollout as text, new rollout as text |

Rules that raise an error:

- `draftNext`: the version is not semver, or is not greater than `current`.
- `promote`: `next` is null.
- `rollback`: `last` is null.
- `setRollout`: `n` is not an integer from 0 to 100, or `n > 0` while `next` is null.

## Validation

`validateRecord` takes any JSON value and never fails. It returns `ok` and a list of error messages. Each message starts with the name of the field, such as `rollout must be an integer from 0 to 100` or `history[1].at must be an ISO 8601 date-time`. Copy the messages from `src/validate.ts`. The vectors compare only the field name at the start of each message, and their order.

Things that are easy to get wrong:

- A missing `last` or `next` is an error. An explicit `null` is fine.
- A missing history entry `from` or `to` is an error. `null` is fine.
- The ordering checks (`next` above `current`, `last` below `current`, `rollout` 0 without a next) run only when no other error was found.
- A boolean is not an integer. A number such as `10.0` is.
- Unknown keys are errors, in the order they appear in the record. Languages with unordered maps may sort them.
- Slugs, semver and date-times must match the whole string. In many regex engines `$` also matches before a trailing newline, so use an end of text anchor or check the match length. The vectors include these cases.
- Use `[0-9]` for digits, not `\d`, which matches other scripts in some engines.
- The date-time check follows the reference, which is lenient. It accepts any day from 1 to 31 in any month, and `24:00:00`. It rejects month 13, hour 25, minute or second 60, and offsets of 24 hours or more.

## Semver

The pattern is the one in `schema/module-record.schema.json`. Compare as the semver spec says and ignore build metadata. Compare number parts as digit strings, by length and then by text, so large numbers cannot overflow. A prerelease sorts below its release. Numeric prerelease identifiers sort below text ones.

## The client

- The source is a function from module slug to record or nothing, or a URL.
- A URL containing `{module}` has it replaced. Any other URL is a base, and the client fetches `<base>/<module>.json` with trailing slashes on the base removed.
- A 404 means no record. Any other failure or non-2xx status is `SOURCE_ERROR`. A body that is not JSON is `SOURCE_ERROR`.
- Check the module slug first. A bad slug is `INVALID_INPUT` and never reaches the source.
- No record is `NOT_FOUND`. A record that fails validation is `INVALID_RECORD`.
- Cache each validated record for the TTL, 30 seconds by default.
- Concurrent loads of one module share a single request.
- When a refresh fails with `SOURCE_ERROR` and an old record exists, return the old record and restart its TTL. Do not hide `NOT_FOUND` or `INVALID_RECORD`.
- Provide a way to clear one record or all of them, and a clock you can replace in tests.

## The vectors

`spec/vectors.json` is generated from the TypeScript code by `npm run spec:generate`. Do not edit it by hand. The TypeScript tests fail if the file is out of date. It has these parts:

| Key | Each case has | The port must |
| --- | --- | --- |
| `bucket` | `module`, `userId`, `bucket` | Return that bucket |
| `resolve` | `name`, `record`, `userId` (null for none), `expected` | Return the same version, channel, reason and bucket |
| `transitions` | `name`, `op`, `args`, `record`, `now`, `by`, then `expected` or `error` | Return the expected record, or fail with that error code |
| `validation` | `name`, `record`, `ok`, `errors` | Agree on `ok` and on the field names, in order |
| `semver.compare` | `a`, `b`, `expected` | Return -1, 0 or 1 |
| `semver.valid` | `value`, `valid` | Agree on validity |

For transitions, `op` is `promote`, `rollback`, `setRollout` (with `args.n`) or `draftNext` (with `args.version` and an optional `args.patch`). `now` is a fixed time in UTC with milliseconds. A typed port can skip a case that its types rule out, such as a fractional rollout, as long as the type system rejects it.

A new port reads the file from the repository, runs every case, and adds its own tests for the client. Then add a job to `.github/workflows/ci.yml` and a row to the table in the README.
