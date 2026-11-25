# Versimo

A release model with no staging.

Every module of your product (billing, sign-in, search) has three versions: **last**, **current** and **next**. Next is user acceptance testing on live, behind a flag that reaches a percentage of your users. When next is good, you promote it. Next becomes current and current becomes last. If current fails its health checks, users go back to last on their own, and the fix ships as a semver patch.

Versimo is the small, dependency-free library that answers one question: which version of this module should this user get?

- Ports for TypeScript, Python, Go, Kotlin and Swift, all with zero runtime dependencies
- Node 20 and later, modern browsers and React Native
- Deterministic bucketing, so a user stays on the same version as the rollout grows
- Pure functions for promote, rollback, rollout and draft
- A hand-written record validator and a JSON Schema
- An OpenFeature compatible provider, with no OpenFeature import

Site: [versimo.dev](https://versimo.dev)

## Languages

Every port gives the same answer for the same record and user. They are checked against the same [test vectors](spec/vectors.json).

| Language | Package | Install | Docs |
| --- | --- | --- | --- |
| TypeScript and JavaScript, including React Native | Versimo for TypeScript | `npm install versimo` | This page |
| Python 3.10 and later | Versimo for Python | `pip install "git+https://github.com/luca-sia/versimo#subdirectory=packages/python"` | [packages/python](packages/python/README.md) |
| Go 1.22 and later | Versimo for Go | `go get github.com/luca-sia/versimo/packages/go` | [packages/go](packages/go/README.md) |
| Kotlin and Android | Versimo for Kotlin | Build from source with `gradle publishToMavenLocal`. Not on Maven Central or JitPack yet | [packages/kotlin](packages/kotlin/README.md) |
| Swift and iOS | Versimo for Swift | SwiftPM URL `https://github.com/luca-sia/versimo` | [packages/swift](packages/swift/README.md) |

Writing another port? See [docs/porting.md](docs/porting.md).

## Install

The rest of this page uses TypeScript.

```sh
npm install versimo
```

The package is not on npm yet. Until it is published, install it from GitHub:

```sh
npm install github:luca-sia/versimo
```

The install builds the package on your machine, so it needs a working `npm` and Node 20 or later.

## Quick start

```ts
import { createClient } from 'versimo';

const versimo = createClient({
  source: 'https://config.example.com/versimo', // fetches /versimo/billing.json
  ttlMs: 30_000,
});

const version = await versimo.version('billing', { userId: 'user-42' });
// "2.4.0" for most users, "2.5.0" for the share of users on next
```

Load the version your code asks for. How you do that is up to you. It might be a dynamic import, a feature branch of a service, or a route to another deployment.

You can also work with a record directly:

```ts
import { resolveVersion, draftNext, setRollout, promote } from 'versimo';

let record = await versimo.record('billing');
record = draftNext(record, '2.6.0', { by: 'alex' });
record = setRollout(record, 10, { by: 'alex' });
record = promote(record, { by: 'alex' });
```

These functions never change the record you pass in. They return a new one with a history entry. Saving it is your job.

## The record

```json
{
  "module": "billing",
  "last": "2.3.1",
  "current": "2.4.0",
  "next": "2.5.0",
  "rollout": 10,
  "healthy": true,
  "updatedAt": "2026-03-12T09:30:00Z"
}
```

The full format is in [docs/record-format.md](docs/record-format.md). The JSON Schema is at [schema/module-record.schema.json](schema/module-record.schema.json).

## Docs

- [Concepts](docs/concepts.md): the model in plain words
- [Usage](docs/usage.md): server, browser, React, React Native, OpenFeature and PostHog
- [Porting](docs/porting.md): the algorithm and the test vectors, for new languages
- [Record format](docs/record-format.md)
- [API reference](docs/api.md)
- [GitHub app](docs/github-app.md): connect a repo, modules from tags, pull requests with auto merge
- [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md)

## Licence

MIT. Copyright 2026 Lucasia Ltd.

---

Thinks with Lucasia.ai
