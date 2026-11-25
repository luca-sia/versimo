# Changelog

All notable changes are listed here. This project follows [semver](https://semver.org).

## Unreleased

- Health checks and automatic rollback: `evaluateHealth`, `checkUrl` and `applyHealth` (TypeScript, ports follow)

## 0.2.0

- Versimo for Python, Go, Kotlin and Swift, in `packages/`
- Shared language-neutral test vectors in `spec/vectors.json`, generated from the TypeScript code with `npm run spec:generate`
- `bucketFor` works on engines without `TextEncoder`, such as older React Native
- Docs for React Native and for porting to other languages
- A release workflow that publishes to npm with provenance

## 0.1.0

First release.

- Module record format and JSON Schema (2020-12)
- `resolveVersion` and `resolve` with deterministic bucketing
- `draftNext`, `promote`, `rollback` and `setRollout`, all pure, all logging history
- `validateRecord`, hand-written
- `createClient` with an in-memory cache, a TTL and stale-on-error
- `VersimoProvider`, OpenFeature compatible by structure
- Semver helpers
