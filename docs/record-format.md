# Record format

A record holds the release state of one module. It is a JSON document. The schema is [schema/module-record.schema.json](../schema/module-record.schema.json) (JSON Schema 2020-12). An example is [schema/examples/billing.json](../schema/examples/billing.json).

```json
{
  "$schema": "https://versimo.dev/schema/module-record.schema.json",
  "module": "billing",
  "last": "2.3.1",
  "current": "2.4.0",
  "next": "2.5.0",
  "rollout": 10,
  "healthy": true,
  "updatedAt": "2026-03-12T09:30:00Z",
  "history": [
    { "at": "2026-03-12T09:30:00Z", "action": "rollout", "from": "0", "to": "10", "by": "alex" }
  ]
}
```

## Fields

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `$schema` | string | no | Link to the schema, for editors |
| `module` | string | yes | Lower-case slug such as `billing` or `sign-in` |
| `last` | semver or null | yes | The version before current. The rollback target |
| `current` | semver | yes | The version most users get |
| `next` | semver or null | yes | The version under test on live |
| `rollout` | integer 0 to 100 | yes | Share of users on next |
| `healthy` | boolean | yes | Health of current. When false, users get last |
| `updatedAt` | ISO 8601 date-time | yes | Time of the last change |
| `history` | array | no | Log of changes, oldest first |

No other fields are allowed.

## History entries

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `at` | ISO 8601 date-time | yes | When it happened |
| `action` | string | yes | `draft`, `promote`, `rollback`, `rollout` or `patch` |
| `from` | string or null | yes | Value before the change |
| `to` | string or null | yes | Value after the change |
| `by` | string | no | Who made the change |
| `reason` | string | no | Why. An automatic rollback writes the failed checks, for example `health: errorRate` |

For `draft`, `promote`, `rollback` and `patch`, `from` and `to` are versions. For `rollout` they are the old and new percentages as strings, for example `"10"` and `"25"`.

## Extra rules

The schema checks shapes. `validateRecord` also checks these rules, which a schema cannot express.

- `next` must be greater than `current`.
- `last` must be lower than `current`.
- `rollout` must be 0 when `next` is null.

Versions follow [semver 2.0](https://semver.org). A leading `v` is not allowed.

## Where records live

Anywhere you can read JSON. A file on a CDN, a row in a database, a config service or a feature flag payload. See [usage](usage.md) for examples.
