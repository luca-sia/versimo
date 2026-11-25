package versimo

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"
)

// RolloutSource returns the share on next for a module, from 0 to 100.
// ok false means no override: the record's own rollout is used.
type RolloutSource func(ctx context.Context, module string) (share int, ok bool)

// PostHogDistinctID is the fixed distinct id sent to PostHog. No user id ever leaves the app.
const PostHogDistinctID = "versimo"

// PostHogFlagKey is the PostHog flag that carries the share for a module.
func PostHogFlagKey(module string) string { return "versimo-" + module }

// RolloutFromFlag reads the share on next from one flag in a PostHog /flags?v=2 answer,
// decoded with encoding/json into any. No flag gives ok false. Flag off gives 0.
// Flag on with a payload {"rollout": n}, n an integer from 0 to 100, gives n.
// Anything else gives ok false.
func RolloutFromFlag(flag any) (int, bool) {
	f, isMap := flag.(map[string]any)
	if !isMap {
		return 0, false
	}
	enabled, isBool := f["enabled"].(bool)
	if !isBool {
		return 0, false
	}
	if !enabled {
		return 0, true
	}
	meta, _ := f["metadata"].(map[string]any)
	payload := meta["payload"]
	if s, isString := payload.(string); isString {
		if err := json.Unmarshal([]byte(s), &payload); err != nil {
			return 0, false
		}
	}
	p, isMap := payload.(map[string]any)
	if !isMap {
		return 0, false
	}
	n, isNum := p["rollout"].(float64)
	if !isNum || n != math.Trunc(n) || n < 0 || n > 100 {
		return 0, false
	}
	return int(n), true
}

// PostHogOptions configure NewPostHogRollout.
type PostHogOptions struct {
	// APIKey is the PostHog project API key (starts with phc_). It is a public key.
	APIKey string
	// Host is the PostHog ingestion host. Default https://eu.i.posthog.com.
	Host string
	// TTL is how long one PostHog answer is cached. Default 30 seconds.
	TTL time.Duration
	// Now is the clock for the cache. Mainly for tests.
	Now func() time.Time
	// HTTPClient makes the request. Default is a client with a 5 second timeout.
	HTTPClient *http.Client
}

// NewPostHogRollout returns a RolloutSource backed by PostHog flags, for ClientOptions.Rollout.
// One request per TTL serves every module. It carries only the project key and the fixed
// distinct id, so no user data is sent. When PostHog cannot be reached the last good answer
// is kept, and with none the record's own rollout is used.
func NewPostHogRollout(o PostHogOptions) (RolloutSource, error) {
	if o.APIKey == "" {
		return nil, newError(CodeInvalidInput, "PostHogOptions needs an APIKey")
	}
	host := o.Host
	if host == "" {
		host = "https://eu.i.posthog.com"
	}
	url := strings.TrimRight(host, "/") + "/flags?v=2"
	ttl := o.TTL
	if ttl == 0 {
		ttl = 30 * time.Second
	}
	now := o.Now
	if now == nil {
		now = time.Now
	}
	hc := o.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: 5 * time.Second}
	}
	body, _ := json.Marshal(map[string]string{"api_key": o.APIKey, "distinct_id": PostHogDistinctID})

	var (
		mu      sync.Mutex
		flags   map[string]any
		expires time.Time
	)
	load := func(ctx context.Context) (map[string]any, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("content-type", "application/json")
		res, err := hc.Do(req)
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		if res.StatusCode < 200 || res.StatusCode > 299 {
			return nil, fmt.Errorf("PostHog returned %d", res.StatusCode)
		}
		raw, err := io.ReadAll(res.Body)
		if err != nil {
			return nil, err
		}
		var answer struct {
			Flags map[string]any `json:"flags"`
		}
		if err := json.Unmarshal(raw, &answer); err != nil {
			return nil, err
		}
		if answer.Flags == nil {
			return nil, fmt.Errorf("PostHog answer has no flags")
		}
		return answer.Flags, nil
	}
	return func(ctx context.Context, module string) (int, bool) {
		mu.Lock()
		defer mu.Unlock()
		if flags == nil || !expires.After(now()) {
			fresh, err := load(ctx)
			switch {
			case err == nil:
				flags = fresh
			case flags == nil:
				// No good answer yet, so use the record.
				return 0, false
			}
			// On error the last good answer is kept for another TTL.
			expires = now().Add(ttl)
		}
		return RolloutFromFlag(flags[PostHogFlagKey(module)])
	}, nil
}
