# Health checks

If current fails, traffic goes back to last on its own and the fix ships as a semver patch. This page is how Versimo does the first half.

## Checks

Each module gets its own limits. Leave one out to turn it off.

| Check | Field | Fails when |
| --- | --- | --- |
| Error rate | `maxErrorRate` (0 to 1) | `errors / requests` is above it, once there are at least `minRequests` requests (default 1) |
| Latency | `maxLatencyMs` | the measured latency (usually p95) is above it |
| Custom URL | `url` | the URL does not answer with a 2xx status, or cannot be reached |

A value equal to the limit passes.

## What happens on a failure

1. Current steps back to last. This is `rollback`: last becomes current, next and the rollout are cleared.
2. The history entry says why, for example `{ "action": "rollback", "by": "versimo-health", "reason": "health: errorRate" }`.
3. An alert is sent.

If there is no last, nothing changes and only the alert goes out, once per failing version.

Then draft the fix as a patch, `draftNext(record, '2.4.1', { patch: true })`, and roll it out as usual.

## Running it

```ts
import { createHealthMonitor } from 'versimo';

const monitor = createHealthMonitor({
  store: {
    read: (module) => loadRecord(module),     // your record store
    write: (record) => saveRecord(record),
  },
  checks: {
    billing: { maxErrorRate: 0.02, maxLatencyMs: 800, url: 'https://billing.example.com/health', minRequests: 100 },
  },
  posthog: {
    host: 'https://eu.posthog.com',
    projectId: process.env.POSTHOG_PROJECT_ID!,
    apiKey: process.env.POSTHOG_PERSONAL_API_KEY!,
  },
  observe: async (module) => ({ latencyMs: await p95(module) }), // optional, your own numbers
  alert: process.env.SLACK_WEBHOOK_URL, // or a function
});

const stop = monitor.start(['billing', 'sign-in'], 60_000);
```

`monitor.check('billing')` runs once, which suits a cron job or a scheduled Worker.

The numbers come from three places, and later ones win: PostHog, the URL check, then your `observe` function.

## PostHog error tracking

When `posthog` is set and a module has `maxErrorRate`, the monitor asks PostHog how many events and how many `$exception` events there were for that module and version in the last `windowMinutes` (default 5).

For this to work, tag your events with the module and the version the user got:

```ts
posthog.register({ versimo_module: 'billing', versimo_version: version });
```

The property names can be changed with `moduleProperty` and `versionProperty`. The API key needs query read access. Keep it in your secret store, never in the repo.

## Alerts

A webhook URL gets a JSON POST with `module`, `at`, `version`, `rolledBack`, `current`, `failures` and `text`. The `text` field makes it work with a Slack incoming webhook as it is:

> Versimo: billing 2.4.0 failed its health checks (errorRate). Rolled back to 2.3.1.

## Other languages

`evaluateHealth` and `checkHealth` are in every port and give the same result, checked by the `health` cases in [spec/vectors.json](../spec/vectors.json). The monitor is TypeScript only for now. In another language, measure, call `checkHealth`, and save the record when `rolledBack` is true.
