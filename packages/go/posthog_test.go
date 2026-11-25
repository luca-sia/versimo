package versimo

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func onFlag(rollout int) map[string]any {
	p, _ := json.Marshal(map[string]int{"rollout": rollout})
	return map[string]any{"enabled": true, "metadata": map[string]any{"payload": string(p)}}
}

// fakePostHog serves answers in order, repeating the last one. An int answer is a status code.
func fakePostHog(t *testing.T, answers ...any) (*httptest.Server, *int32, *[]string) {
	t.Helper()
	var calls int32
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		i := int(atomic.AddInt32(&calls, 1)) - 1
		if i >= len(answers) {
			i = len(answers) - 1
		}
		b, _ := io.ReadAll(r.Body)
		bodies = append(bodies, r.Method+" "+r.URL.String()+" "+string(b))
		if code, isCode := answers[i].(int); isCode {
			w.WriteHeader(code)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"flags": answers[i]})
	}))
	t.Cleanup(srv.Close)
	return srv, &calls, &bodies
}

func phClient(t *testing.T, rec ModuleRecord, o PostHogOptions) *Client {
	t.Helper()
	if o.APIKey == "" {
		o.APIKey = "phc_test"
	}
	rollout, err := NewPostHogRollout(o)
	if err != nil {
		t.Fatal(err)
	}
	c, err := NewClient(ClientOptions{
		Source:  func(context.Context, string) (*ModuleRecord, error) { r := rec; return &r, nil },
		Rollout: rollout,
	})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestPostHogShareDrivesNext(t *testing.T) {
	srv, _, _ := fakePostHog(t, map[string]any{"versimo-billing": onFlag(100)})
	rec := sampleRecord()
	rec.Rollout = 0
	c := phClient(t, rec, PostHogOptions{Host: srv.URL})
	r, err := c.Resolve(context.Background(), "billing", "user-42")
	if err != nil {
		t.Fatal(err)
	}
	if r.Version != "2.5.0" || r.Channel != "next" || r.Bucket == nil || *r.Bucket != 33 {
		t.Fatalf("got %+v", r)
	}
}

func TestPostHogBoundaryFollowsBucket(t *testing.T) {
	for share, want := range map[int]string{33: "2.4.0", 34: "2.5.0"} {
		srv, _, _ := fakePostHog(t, map[string]any{"versimo-billing": onFlag(share)})
		rec := sampleRecord()
		rec.Rollout = 0
		got, _ := phClient(t, rec, PostHogOptions{Host: srv.URL}).Version(context.Background(), "billing", "user-42")
		if got != want {
			t.Errorf("share %d: got %s, want %s", share, got, want)
		}
	}
}

func TestPostHogFlagOffAndMissing(t *testing.T) {
	rec := sampleRecord()
	rec.Rollout = 100
	srv, _, _ := fakePostHog(t, map[string]any{"versimo-billing": map[string]any{"enabled": false}})
	if got, _ := phClient(t, rec, PostHogOptions{Host: srv.URL}).Version(context.Background(), "billing", "user-42"); got != "2.4.0" {
		t.Errorf("flag off: got %s", got)
	}
	srv2, _, _ := fakePostHog(t, map[string]any{"versimo-search": onFlag(0)})
	if got, _ := phClient(t, rec, PostHogOptions{Host: srv2.URL}).Version(context.Background(), "billing", "user-42"); got != "2.5.0" {
		t.Errorf("no flag: got %s", got)
	}
}

func TestPostHogUnhealthyGoesToLast(t *testing.T) {
	srv, _, _ := fakePostHog(t, map[string]any{"versimo-billing": onFlag(100)})
	rec := sampleRecord()
	rec.Healthy = false
	if got, _ := phClient(t, rec, PostHogOptions{Host: srv.URL}).Version(context.Background(), "billing", "user-42"); got != "2.3.1" {
		t.Errorf("got %s", got)
	}
}

func TestPostHogDownUsesRecord(t *testing.T) {
	srv, _, _ := fakePostHog(t, 503)
	rec := sampleRecord()
	rec.Rollout = 100
	if got, _ := phClient(t, rec, PostHogOptions{Host: srv.URL}).Version(context.Background(), "billing", "user-42"); got != "2.5.0" {
		t.Errorf("got %s", got)
	}
}

func TestPostHogKeepsLastGoodAnswerAndCachesPerTTL(t *testing.T) {
	srv, calls, _ := fakePostHog(t, map[string]any{"versimo-billing": onFlag(100), "versimo-search": onFlag(20)}, 500)
	clk := &clock{t: time.Unix(0, 0)}
	rollout, _ := NewPostHogRollout(PostHogOptions{APIKey: "phc_test", Host: srv.URL, TTL: time.Second, Now: clk.now})
	ctx := context.Background()
	if n, ok := rollout(ctx, "billing"); !ok || n != 100 {
		t.Fatalf("got %d %v", n, ok)
	}
	if n, ok := rollout(ctx, "search"); !ok || n != 20 {
		t.Fatalf("got %d %v", n, ok)
	}
	if *calls != 1 {
		t.Fatalf("calls %d", *calls)
	}
	clk.t = clk.t.Add(time.Second)
	if n, ok := rollout(ctx, "billing"); !ok || n != 100 {
		t.Fatalf("after error got %d %v", n, ok)
	}
	if *calls != 2 {
		t.Fatalf("calls %d", *calls)
	}
}

func TestPostHogSendsNoUserData(t *testing.T) {
	srv, _, bodies := fakePostHog(t, map[string]any{"versimo-billing": onFlag(50)})
	c := phClient(t, sampleRecord(), PostHogOptions{Host: srv.URL + "/"})
	if _, err := c.Resolve(context.Background(), "billing", "sealed-client-user-7"); err != nil {
		t.Fatal(err)
	}
	if len(*bodies) != 1 {
		t.Fatalf("requests %d", len(*bodies))
	}
	want := `POST /flags?v=2 {"api_key":"phc_test","distinct_id":"versimo"}`
	if (*bodies)[0] != want {
		t.Errorf("got %q, want %q", (*bodies)[0], want)
	}
	if strings.Contains((*bodies)[0], "sealed-client-user-7") {
		t.Error("user id sent to PostHog")
	}
}

func TestPostHogNeedsAPIKey(t *testing.T) {
	if _, err := NewPostHogRollout(PostHogOptions{}); codeOf(err) != CodeInvalidInput {
		t.Errorf("got %v", err)
	}
}

func TestClientIgnoresOutOfRangeRollout(t *testing.T) {
	rec := sampleRecord()
	rec.Rollout = 100
	c, _ := NewClient(ClientOptions{
		Source:  func(context.Context, string) (*ModuleRecord, error) { r := rec; return &r, nil },
		Rollout: func(context.Context, string) (int, bool) { return 150, true },
	})
	got, _ := c.Record(context.Background(), "billing")
	if got.Rollout != 100 {
		t.Errorf("got %d", got.Rollout)
	}
}
