# Changelog

All notable changes are listed here. This project follows [semver](https://semver.org).

## Unreleased

- PostHog flags drive next. `postHogRollout` reads the share on next for each module from the PostHog flag `versimo-<module>`, so a rollout change needs no deploy. Bucketing stays with Versimo, so users land on the same version in every language. No user data is sent to PostHog.
- `createClient` takes a `rollout` option that overrides the record's share
- Python (`PostHogRollout`) and Go (`NewPostHogRollout`) get the same
- `posthog` section in `spec/vectors.json`

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
