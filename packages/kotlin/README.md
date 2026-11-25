# Versimo for Kotlin

Resolve the last, current and next version of a module for each user. No dependencies. It runs on the JVM and on Android (Java 8 bytecode, `HttpURLConnection` for fetching).

Versimo is a release model with no staging. See the [main README](../../README.md) for the idea.

## Install

The library is not on Maven Central or JitPack yet. Build it from source and publish it to your local Maven repository:

```sh
cd packages/kotlin
gradle publishToMavenLocal
```

Then add it to your project:

```kotlin
repositories { mavenLocal() }
dependencies { implementation("dev.versimo:versimo:0.2.0") }
```

## Quick start

```kotlin
import dev.versimo.VersimoClient

val versimo = VersimoClient.fromUrl("https://config.example.com/versimo") // fetches /versimo/billing.json

val version = versimo.version("billing", userId = "user-42")
// "2.4.0" for most users, "2.5.0" for the share of users on next
```

The client blocks. On Android, call it from a background thread or a coroutine dispatcher such as `Dispatchers.IO`, and declare the `INTERNET` permission.

To load records from your own store, pass a `RecordSource`. Return null when a module does not exist.

```kotlin
val versimo = VersimoClient(source = { module -> store.find(module) }, ttlMs = 15_000)
```

Records are validated when fetched and cached for `ttlMs` (30 seconds by default). If the source fails after the cache expires, the stale record is served. Errors are thrown as `VersimoException` with a `code`.

To use OkHttp or another HTTP stack, pass your own `HttpFetcher` to `VersimoClient.fromUrl`.

## Working with records

```kotlin
import dev.versimo.*

var record = versimo.record("billing")
record = draftNext(record, "2.6.0", TransitionOptions(by = "alex"))
record = setRollout(record, 10, TransitionOptions(by = "alex"))
record = promote(record, TransitionOptions(by = "alex"))

resolve(record, "user-42") // Resolution(version, channel, reason, bucket)
record.toJson()
```

Records are immutable data classes. Transitions return a new one and never change the input. Saving it is your job. Set `nowMillis` in `TransitionOptions` to fix the time in tests. `ModuleRecord.fromJson` parses and validates, and `validateRecord` checks any parsed JSON value.

## Tests

```sh
cd packages/kotlin
gradle test
```

The tests read the shared vectors in [spec/vectors.json](../../spec/vectors.json).
