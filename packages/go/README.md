# Versimo for Go

Resolve the last, current and next version of a module for each user. Standard library only. Go 1.22 and later.

Versimo is a release model with no staging. See the [main README](../../README.md) for the idea.

## Install

```sh
go get github.com/luca-sia/versimo/packages/go
```

## Quick start

```go
import (
	"context"

	versimo "github.com/luca-sia/versimo/packages/go"
)

client, _ := versimo.NewClient(versimo.ClientOptions{
	URL: "https://config.example.com/versimo", // fetches /versimo/billing.json
})

version, err := client.Version(context.Background(), "billing", "user-42")
// "2.4.0" for most users, "2.5.0" for the share of users on next
```

Use `Source` instead of `URL` to load records from your own store. Return `nil, nil` when a module does not exist.

```go
client, _ := versimo.NewClient(versimo.ClientOptions{
	Source: func(ctx context.Context, module string) (*versimo.ModuleRecord, error) {
		return store.Find(ctx, module)
	},
	TTL: 15 * time.Second,
})
```

Records are validated when fetched and cached for `TTL` (30 seconds by default). If the source fails after the cache expires, the stale record is served. Read the error code with `errors.As`:

```go
var ve *versimo.Error
if errors.As(err, &ve) && ve.Code == versimo.CodeNotFound { ... }
```

## Working with records

```go
rec, _ := client.Record(ctx, "billing")
rec, _ = versimo.DraftNext(rec, "2.6.0", versimo.DraftOptions{TransitionOptions: versimo.TransitionOptions{By: "alex"}})
rec, _ = versimo.SetRollout(rec, 10, versimo.TransitionOptions{By: "alex"})
rec, _ = versimo.Promote(rec, versimo.TransitionOptions{By: "alex"})

res := versimo.Resolve(rec, "user-42") // Version, Channel, Reason, Bucket
```

These functions return a new record and never change the one you pass in. Saving it is your job. Set `Now` in `TransitionOptions` to fix the time in tests. `ValidateRecord` takes decoded JSON or a `ModuleRecord`, and `ParseRecord` decodes and validates bytes.

## Tests

```sh
cd packages/go
go test ./...
```

The tests read the shared vectors in [spec/vectors.json](../../spec/vectors.json).
