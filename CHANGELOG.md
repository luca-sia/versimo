# Changelog

All notable changes are listed here. This project follows [semver](https://semver.org).

## 0.1.0

First release.

- Module record format and JSON Schema (2020-12)
- `resolveVersion` and `resolve` with deterministic bucketing
- `draftNext`, `promote`, `rollback` and `setRollout`, all pure, all logging history
- `validateRecord`, hand-written
- `createClient` with an in-memory cache, a TTL and stale-on-error
- `VersimoProvider`, OpenFeature compatible by structure
- Semver helpers
