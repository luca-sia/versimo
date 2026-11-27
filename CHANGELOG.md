# Changelog

All notable changes are listed here. This project follows [semver](https://semver.org).

## 0.3.0

- Apps read their records from versimo.dev with the project's read key: `createClient({ source: 'https://versimo.dev/api/records/<read key>' })`
- `createDeployClient` and the `versimo` command change a project's modules from CI with its deploy key: `create`, `draft`, `rollout`, `promote`, `rollback`, `list`
- The app API signs in through Lucasia ID: endpoints and keys from discovery, a nonce, the ID token checked before a session starts, and the client secret sent as `client_secret_basic`
- PostHog flags drive next. `postHogRollout` reads the share on next for each module from the PostHog flag `versimo-<module>`, so a rollout change needs no deploy. Bucketing stays with Versimo, so users land on the same version in every language. No user data is sent to PostHog.
- `createClient` takes a `rollout` option that overrides the record's share
- Python (`PostHogRollout`) and Go (`NewPostHogRollout`) get the same
- `posthog` section in `spec/vectors.json`
- The app API writes each module's share to the project's own PostHog flag, so the slider on versimo.dev drives next. Connect with `PUT /api/projects/:id/posthog`. The personal key is sealed at rest

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
