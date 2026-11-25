package versimo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Source returns the record for a module, or nil when there is none.
type Source func(ctx context.Context, module string) (*ModuleRecord, error)

// ClientOptions configure a Client. Set Source, or set URL.
type ClientOptions struct {
	// Source is a function returning the record for a module.
	Source Source
	// URL is used when Source is nil. A URL containing {module} has it replaced.
	// Any other URL is a base and the client fetches <base>/<module>.json.
	URL string
	// TTL is how long a record is cached. Default 30 seconds.
	TTL time.Duration
	// Now is the clock for the cache. Mainly for tests.
	Now func() time.Time
	// HTTPClient is used for URL sources. Default is a client with a 10 second timeout.
	HTTPClient *http.Client
}

type cached struct {
	record  ModuleRecord
	expires time.Time
}

// Client resolves versions from a source, with a TTL cache and stale-on-error.
// It is safe for concurrent use.
type Client struct {
	source func(ctx context.Context, module string) (any, error)
	ttl    time.Duration
	now    func() time.Time

	mu    sync.Mutex
	cache map[string]cached
	locks map[string]*sync.Mutex
}

var slugRe2 = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

// NewClient makes a client. It returns an error when there is no source.
func NewClient(o ClientOptions) (*Client, error) {
	c := &Client{ttl: o.TTL, now: o.Now, cache: map[string]cached{}, locks: map[string]*sync.Mutex{}}
	if c.ttl == 0 {
		c.ttl = 30 * time.Second
	}
	if c.now == nil {
		c.now = time.Now
	}
	switch {
	case o.Source != nil:
		src := o.Source
		c.source = func(ctx context.Context, module string) (any, error) {
			rec, err := src(ctx, module)
			if rec == nil {
				return nil, err
			}
			return *rec, err
		}
	case o.URL != "":
		hc := o.HTTPClient
		if hc == nil {
			hc = &http.Client{Timeout: 10 * time.Second}
		}
		c.source = urlSource(o.URL, hc)
	default:
		return nil, newError(CodeInvalidInput, "ClientOptions needs a Source or a URL")
	}
	return c, nil
}

func urlSource(url string, hc *http.Client) func(context.Context, string) (any, error) {
	return func(ctx context.Context, module string) (any, error) {
		target := strings.TrimRight(url, "/") + "/" + module + ".json"
		if strings.Contains(url, "{module}") {
			target = strings.Replace(url, "{module}", module, 1)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return nil, &Error{Code: CodeSourceError, Message: "Could not fetch " + target + ": " + err.Error(), Err: err}
		}
		res, err := hc.Do(req)
		if err != nil {
			return nil, &Error{Code: CodeSourceError, Message: "Could not fetch " + target + ": " + err.Error(), Err: err}
		}
		defer res.Body.Close()
		if res.StatusCode == http.StatusNotFound {
			return nil, nil
		}
		if res.StatusCode < 200 || res.StatusCode > 299 {
			return nil, newError(CodeSourceError, fmt.Sprintf("Fetching %s returned %d", target, res.StatusCode))
		}
		body, err := io.ReadAll(res.Body)
		if err != nil {
			return nil, &Error{Code: CodeSourceError, Message: "Could not read " + target + ": " + err.Error(), Err: err}
		}
		var raw any
		if err := json.Unmarshal(body, &raw); err != nil {
			return nil, &Error{Code: CodeSourceError, Message: "Fetching " + target + " returned invalid JSON: " + err.Error(), Err: err}
		}
		return raw, nil
	}
}

func (c *Client) lockFor(module string) *sync.Mutex {
	c.mu.Lock()
	defer c.mu.Unlock()
	l, ok := c.locks[module]
	if !ok {
		l = &sync.Mutex{}
		c.locks[module] = l
	}
	return l
}

func (c *Client) load(ctx context.Context, module string) (ModuleRecord, error) {
	raw, err := c.source(ctx, module)
	if err != nil {
		var ve *Error
		if errors.As(err, &ve) {
			return ModuleRecord{}, err
		}
		return ModuleRecord{}, &Error{Code: CodeSourceError, Message: err.Error(), Err: err}
	}
	if raw == nil {
		return ModuleRecord{}, newError(CodeNotFound, fmt.Sprintf("No record for module %q", module))
	}
	return recordFromValue(raw, module)
}

// Record returns the cached or freshly loaded, validated record.
// If a refresh fails with a source error and a stale record exists, the stale record is returned.
func (c *Client) Record(ctx context.Context, module string) (ModuleRecord, error) {
	if !slugRe2.MatchString(module) {
		return ModuleRecord{}, newError(CodeInvalidInput, fmt.Sprintf("Invalid module slug: %q", module))
	}
	// One lock per module, so concurrent callers share a single load.
	l := c.lockFor(module)
	l.Lock()
	defer l.Unlock()

	c.mu.Lock()
	hit, ok := c.cache[module]
	c.mu.Unlock()
	if ok && hit.expires.After(c.now()) {
		return hit.record, nil
	}
	rec, err := c.load(ctx, module)
	if err != nil {
		var ve *Error
		if ok && errors.As(err, &ve) && ve.Code == CodeSourceError {
			c.store(module, hit.record)
			return hit.record, nil
		}
		return ModuleRecord{}, err
	}
	c.store(module, rec)
	return rec, nil
}

func (c *Client) store(module string, rec ModuleRecord) {
	c.mu.Lock()
	c.cache[module] = cached{record: rec, expires: c.now().Add(c.ttl)}
	c.mu.Unlock()
}

// Resolve returns the resolution for a user. An empty userID means no user.
func (c *Client) Resolve(ctx context.Context, module, userID string) (Resolution, error) {
	rec, err := c.Record(ctx, module)
	if err != nil {
		return Resolution{}, err
	}
	return Resolve(rec, userID), nil
}

// Version returns the version string this user should get.
func (c *Client) Version(ctx context.Context, module, userID string) (string, error) {
	r, err := c.Resolve(ctx, module, userID)
	return r.Version, err
}

// Clear drops one cached record.
func (c *Client) Clear(module string) {
	c.mu.Lock()
	delete(c.cache, module)
	c.mu.Unlock()
}

// ClearAll drops every cached record.
func (c *Client) ClearAll() {
	c.mu.Lock()
	c.cache = map[string]cached{}
	c.mu.Unlock()
}
