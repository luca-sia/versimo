# Versimo for Swift

Resolve the last, current and next version of a module for each user. Foundation only. iOS 15 and later, macOS 12 and later.

Versimo is a release model with no staging. See the [main README](../../README.md) for the idea.

## Install

Add the repository with Swift Package Manager:

```swift
.package(url: "https://github.com/luca-sia/versimo", from: "0.2.0")
```

and the product `Versimo` to your target.

## Quick start

```swift
import Versimo

let versimo = VersimoClient.url("https://config.example.com/versimo") // fetches /versimo/billing.json

let version = try await versimo.version("billing", userId: "user-42")
// "2.4.0" for most users, "2.5.0" for the share of users on next
```

To load records from your own store, pass a source. Return nil when a module does not exist.

```swift
let versimo = VersimoClient(source: { module in try await store.find(module) }, ttl: 15)
```

`VersimoClient` is an actor. Records are validated when fetched and cached for `ttl` seconds (30 by default). Concurrent calls for one module share a single load. If the source fails after the cache expires, the stale record is served. Errors are `VersimoError` values with a `code`.

## Working with records

```swift
var record = try await versimo.record("billing")
record = try draftNext(record, version: "2.6.0", options: TransitionOptions(by: "alex"))
record = try setRollout(record, to: 10, options: TransitionOptions(by: "alex"))
record = try promote(record, options: TransitionOptions(by: "alex"))

resolve(record, userId: "user-42") // Resolution(version:channel:reason:bucket:)
let data = try record.encoded()
```

Records are value types. Transitions return a new one and never change the input. Saving it is your job. Set `now` in `TransitionOptions` to fix the time in tests. `ModuleRecord(data:)` parses and validates, and `validateRecord` checks any `JSONValue`.

## Tests

```sh
cd packages/swift
swift test
```

The tests read a copy of the shared vectors from `Tests/VersimoTests/Resources/vectors.json`. Run `npm run spec:generate` in the repository root to refresh it.
