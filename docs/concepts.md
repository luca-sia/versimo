# Concepts

## No staging

A staging environment is a copy of production that is never quite the same. It has other data, other traffic and other load. Bugs hide there and show up on live.

Versimo skips it. You test on live, with real users, in small steps. The price of a mistake is kept small by three rules.

## Three versions

Each module has three versions at any time.

- **Last** is the version that was current before. It is the way back.
- **Current** is the version most users get.
- **Next** is the version under test on live. It may be empty.

A module is one deployable piece of your product, such as billing, sign-in or search. Each has its own record and its own versions.

## Rollout

A rollout is a whole number from 0 to 100. It is the share of users who get next. At 0, nobody does. At 100, everybody does.

Every user has a bucket from 0 to 99 for each module. The bucket comes from a stable hash of the module and the user id. A user is on next when their bucket is below the rollout.

Two things follow from this.

- The same user always lands in the same bucket, so they do not flip between versions on each visit.
- Raising the rollout only adds users. Nobody who was on next is moved back to current.

Buckets differ per module, so the same users are not always the first to see every new version.

The hash is FNV-1a over the UTF-8 bytes of the module, a zero byte and the user id. A murmur3 style finaliser mixes the bits, and the result is taken modulo 100. Another language can port it in a few lines.

## Promote

Promote is how next becomes current.

- Current becomes last.
- Next becomes current.
- Next is emptied and the rollout goes back to 0.

Promote when next has run on live for long enough and looks good.

## Health and rollback

Your health checks decide whether current is healthy. Versimo does not run checks. Your tooling sets `healthy` to `false` on the record.

While `healthy` is `false`, every user gets last. This is the automatic step back and it needs no deploy. If there is no last, users stay on current, because there is nothing better to serve.

`rollback` makes the step back permanent in the record. Last becomes current. The failed version and any drafted next are dropped, so there is nothing to roll back to until the next promote.

## Health and automatic rollback

Versimo can also judge health and step back for you. Feed `evaluateHealth` the numbers you already collect: requests, errors, p95 latency and any custom checks, such as `checkUrl` on a health endpoint. It says whether current is healthy and why not.

Pass the result to `applyHealth`. A healthy result changes nothing. An unhealthy result with a last does the same as `rollback`: last becomes current, `healthy` is true on the restored version, and the history records it with `by: 'versimo-health'`. An unhealthy result with no last sets `healthy` to false, so users get the `UNHEALTHY` path above. Either way `onAlert` is called once, so you can tell someone.

With too few requests the error rate is not judged, because a handful of errors is noise. A failed custom check always counts. Versimo still does not run the checks on a schedule or save the record. That stays with your tooling.

## Patch

The fix for a failed version ships as a semver patch. After a rollback to `2.3.1`, a fix for `2.4.0` is drafted as `2.4.1`. It goes through the same path as any next: draft, rollout, promote. Pass `{ patch: true }` to `draftNext` to record it as a patch in the history.

## The whole cycle

1. `draftNext(record, '2.5.0')` puts 2.5.0 in next at 0%.
2. `setRollout(record, 5)`, then 25, then 100 as confidence grows.
3. `promote(record)` makes 2.5.0 current.
4. If it fails, `healthy` goes false and users get last at once.
5. `rollback(record)` records the step back.
6. `draftNext(record, '2.5.1', { patch: true })` starts the fix.
