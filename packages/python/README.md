# Versimo for Python

Resolve the last, current and next version of a module for each user. Standard library only. Python 3.10 and later.

Versimo is a release model with no staging. See the [main README](../../README.md) for the idea.

## Install

```sh
pip install "git+https://github.com/luca-sia/versimo#subdirectory=packages/python"
```

## Quick start

```python
from versimo import Client

versimo = Client("https://config.example.com/versimo")  # fetches /versimo/billing.json

version = versimo.version("billing", "user-42")
# "2.4.0" for most users, "2.5.0" for the share of users on next
```

A source can also be a function that takes the module slug and returns a record dict, or `None`:

```python
versimo = Client(lambda module: db.find_record(module), ttl_ms=15_000)
```

Records are plain dicts with the keys of the [record format](../../docs/record-format.md). They are validated when fetched and cached for `ttl_ms` (30 seconds by default). If the source fails after the cache expires, the stale record is served.

## Working with records

```python
from versimo import draft_next, set_rollout, promote, resolve

record = versimo.record("billing")
record = draft_next(record, "2.6.0", by="alex")
record = set_rollout(record, 10, by="alex")
record = promote(record, by="alex")

resolve(record, "user-42")  # Resolution(version=..., channel=..., reason=..., bucket=...)
```

These functions never change the dict you pass in. They return a new one with a history entry. Saving it is your job. Pass `now=` (a `datetime`, an ISO string or milliseconds) to fix the time in tests.

## API

| Name | Purpose |
| --- | --- |
| `bucket_for(module, user_id)` | The user's bucket, 0 to 99 |
| `resolve(record, user_id=None)` | A `Resolution` with version, channel, reason and bucket |
| `resolve_version(record, user_id=None)` | The version string |
| `draft_next`, `promote`, `rollback`, `set_rollout` | Pure record changes |
| `validate_record(value)` | `ValidationResult(ok, errors)`, never raises |
| `compare_semver`, `is_semver`, `parse_semver` | Semver helpers |
| `Client(source, ttl_ms=30000, now=None, fetch=None, timeout=10.0)` | `record`, `resolve`, `version`, `clear` |
| `VersimoError` | Has a `code`: `INVALID_INPUT`, `INVALID_RECORD`, `NOT_FOUND` or `SOURCE_ERROR` |

The client is thread safe and blocking. Concurrent calls for one module share a single load.

## Tests

```sh
cd packages/python
PYTHONPATH=src python3 -m unittest discover -s tests
```

The tests read the shared vectors in [spec/vectors.json](../../spec/vectors.json).
