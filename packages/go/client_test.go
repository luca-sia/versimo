package versimo

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func sampleRecord() ModuleRecord {
	return ModuleRecord{
		Module: "billing", Last: Ptr("2.3.1"), Current: "2.4.0", Next: Ptr("2.5.0"),
		Rollout: 10, Healthy: true, UpdatedAt: "2026-03-12T09:30:00Z",
	}
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func codeOf(err error) ErrorCode {
	var ve *Error
	if errors.As(err, &ve) {
		return ve.Code
	}
	return ""
}

func counting(rec *ModuleRecord) (Source, *int32) {
	var calls int32
	return func(ctx context.Context, module string) (*ModuleRecord, error) {
		atomic.AddInt32(&calls, 1)
		return rec, nil
	}, &calls
}

func TestCachesUntilTTLRunsOut(t *testing.T) {
	ctx := context.Background()
	clk := &clock{time.Unix(0, 0)}
	rec := sampleRecord()
	src, calls := counting(&rec)
	c, _ := NewClient(ClientOptions{Source: src, TTL: time.Second, Now: clk.now})
	_, _ = c.Version(ctx, "billing", "a")
	_, _ = c.Version(ctx, "billing", "b")
	if *calls != 1 {
		t.Fatalf("calls = %d, want 1", *calls)
	}
	clk.t = time.Unix(0, 0).Add(999 * time.Millisecond)
	_, _ = c.Record(ctx, "billing")
	if *calls != 1 {
		t.Fatalf("calls = %d, want 1 before expiry", *calls)
	}
	clk.t = time.Unix(1, 0)
	_, _ = c.Record(ctx, "billing")
	if *calls != 2 {
		t.Fatalf("calls = %d, want 2 after expiry", *calls)
	}
}

func TestClear(t *testing.T) {
	ctx := context.Background()
	rec := sampleRecord()
	src, calls := counting(&rec)
	c, _ := NewClient(ClientOptions{Source: src})
	_, _ = c.Record(ctx, "billing")
	c.Clear("billing")
	_, _ = c.Record(ctx, "billing")
	c.ClearAll()
	_, _ = c.Record(ctx, "billing")
	if *calls != 3 {
		t.Fatalf("calls = %d, want 3", *calls)
	}
}

func TestConcurrentCallsShareOneLoad(t *testing.T) {
	var calls int32
	c, _ := NewClient(ClientOptions{Source: func(ctx context.Context, module string) (*ModuleRecord, error) {
		atomic.AddInt32(&calls, 1)
		time.Sleep(50 * time.Millisecond)
		r := sampleRecord()
		return &r, nil
	}})
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = c.Record(context.Background(), "billing") }()
	}
	wg.Wait()
	if calls != 1 {
		t.Fatalf("calls = %d, want 1", calls)
	}
}

func TestErrors(t *testing.T) {
	ctx := context.Background()
	missing, _ := NewClient(ClientOptions{Source: func(context.Context, string) (*ModuleRecord, error) { return nil, nil }})
	if _, err := missing.Record(ctx, "billing"); codeOf(err) != CodeNotFound {
		t.Errorf("missing: %v", err)
	}
	bad := sampleRecord()
	bad.Rollout = 150
	invalid, _ := NewClient(ClientOptions{Source: func(context.Context, string) (*ModuleRecord, error) { return &bad, nil }})
	if _, err := invalid.Record(ctx, "billing"); codeOf(err) != CodeInvalidRecord {
		t.Errorf("invalid: %v", err)
	}
	down, _ := NewClient(ClientOptions{Source: func(context.Context, string) (*ModuleRecord, error) { return nil, errors.New("down") }})
	if _, err := down.Record(ctx, "billing"); codeOf(err) != CodeSourceError {
		t.Errorf("down: %v", err)
	}
	rec := sampleRecord()
	src, calls := counting(&rec)
	c, _ := NewClient(ClientOptions{Source: src})
	for _, slug := range []string{"../etc/passwd", "Billing", "billing\n", ""} {
		if _, err := c.Record(ctx, slug); codeOf(err) != CodeInvalidInput {
			t.Errorf("slug %q: %v", slug, err)
		}
	}
	if *calls != 0 {
		t.Errorf("source was called %d times for bad slugs", *calls)
	}
	if _, err := NewClient(ClientOptions{}); codeOf(err) != CodeInvalidInput {
		t.Errorf("no source: %v", err)
	}
}

func TestServesStaleRecordWhenSourceFails(t *testing.T) {
	ctx := context.Background()
	clk := &clock{time.Unix(0, 0)}
	var fail atomic.Bool
	c, _ := NewClient(ClientOptions{TTL: 10 * time.Millisecond, Now: clk.now, Source: func(context.Context, string) (*ModuleRecord, error) {
		if fail.Load() {
			return nil, errors.New("down")
		}
		r := sampleRecord()
		return &r, nil
	}})
	_, _ = c.Record(ctx, "billing")
	fail.Store(true)
	clk.t = time.Unix(1, 0)
	r, err := c.Record(ctx, "billing")
	if err != nil || r.Current != "2.4.0" {
		t.Fatalf("stale: %v %v", r, err)
	}
}

func TestStaleIsNotServedForAnInvalidRecord(t *testing.T) {
	ctx := context.Background()
	clk := &clock{time.Unix(0, 0)}
	rec := sampleRecord()
	c, _ := NewClient(ClientOptions{TTL: 10 * time.Millisecond, Now: clk.now, Source: func(context.Context, string) (*ModuleRecord, error) { return &rec, nil }})
	_, _ = c.Record(ctx, "billing")
	rec.Rollout = 500
	clk.t = time.Unix(1, 0)
	if _, err := c.Record(ctx, "billing"); codeOf(err) != CodeInvalidRecord {
		t.Fatalf("got %v", err)
	}
}

func TestURLSource(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.RequestURI())
		switch r.URL.Path {
		case "/records/billing.json", "/api":
			_ = json.NewEncoder(w).Encode(sampleRecord())
		case "/records/broken.json":
			_, _ = w.Write([]byte("<html>"))
		case "/records/boom.json":
			w.WriteHeader(500)
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	ctx := context.Background()

	base, _ := NewClient(ClientOptions{URL: srv.URL + "/records/"})
	if r, err := base.Record(ctx, "billing"); err != nil || r.Current != "2.4.0" || r.Last == nil || *r.Last != "2.3.1" {
		t.Fatalf("base: %+v %v", r, err)
	}
	if _, err := base.Record(ctx, "search"); codeOf(err) != CodeNotFound {
		t.Errorf("404: %v", err)
	}
	if _, err := base.Record(ctx, "boom"); codeOf(err) != CodeSourceError {
		t.Errorf("500: %v", err)
	}
	if _, err := base.Record(ctx, "broken"); codeOf(err) != CodeSourceError {
		t.Errorf("bad json: %v", err)
	}

	tmpl, _ := NewClient(ClientOptions{URL: srv.URL + "/api?m={module}"})
	if _, err := tmpl.Record(ctx, "billing"); err != nil {
		t.Fatal(err)
	}
	if last := seen[len(seen)-1]; last != "/api?m=billing" {
		t.Errorf("placeholder url = %s", last)
	}
}

func TestParseRecord(t *testing.T) {
	rec, err := ParseRecord([]byte(`{"module":"billing","last":null,"current":"1.0.0","next":null,"rollout":0,"healthy":true,"updatedAt":"2026-03-12T09:30:00Z"}`))
	if err != nil || rec.Last != nil || rec.Next != nil || rec.Current != "1.0.0" {
		t.Fatalf("%+v %v", rec, err)
	}
	if _, err := ParseRecord([]byte(`{"module":"billing"}`)); codeOf(err) != CodeInvalidRecord {
		t.Errorf("invalid: %v", err)
	}
	if _, err := ParseRecord([]byte(`nope`)); codeOf(err) != CodeInvalidRecord {
		t.Errorf("not json: %v", err)
	}
}
