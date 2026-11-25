package versimo

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

type vectors struct {
	Bucket []struct {
		Module string `json:"module"`
		UserID string `json:"userId"`
		Bucket int    `json:"bucket"`
	} `json:"bucket"`
	Resolve []struct {
		Name     string         `json:"name"`
		Record   map[string]any `json:"record"`
		UserID   *string        `json:"userId"`
		Expected struct {
			Version string `json:"version"`
			Channel string `json:"channel"`
			Reason  string `json:"reason"`
			Bucket  *int   `json:"bucket"`
		} `json:"expected"`
	} `json:"resolve"`
	Transitions []struct {
		Name     string         `json:"name"`
		Op       string         `json:"op"`
		Args     map[string]any `json:"args"`
		Record   map[string]any `json:"record"`
		Now      string         `json:"now"`
		By       string         `json:"by"`
		Expected map[string]any `json:"expected"`
		Error    string         `json:"error"`
	} `json:"transitions"`
	Validation []struct {
		Name   string   `json:"name"`
		Record any      `json:"record"`
		OK     bool     `json:"ok"`
		Errors []string `json:"errors"`
	} `json:"validation"`
	Semver struct {
		Compare []struct {
			A        string `json:"a"`
			B        string `json:"b"`
			Expected int    `json:"expected"`
		} `json:"compare"`
		Valid []struct {
			Value string `json:"value"`
			Valid bool   `json:"valid"`
		} `json:"valid"`
	} `json:"semver"`
	Posthog []struct {
		Name    string `json:"name"`
		Flag    any    `json:"flag"`
		Rollout *int   `json:"rollout"`
	} `json:"posthog"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	data, err := os.ReadFile("../../spec/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func toRecord(t *testing.T, raw map[string]any) ModuleRecord {
	t.Helper()
	rec, err := recordFromValue(raw, "vector")
	if err != nil {
		t.Fatal(err)
	}
	return rec
}

func TestBucketVectors(t *testing.T) {
	for _, c := range loadVectors(t).Bucket {
		if got := BucketFor(c.Module, c.UserID); got != c.Bucket {
			t.Errorf("BucketFor(%q, %q) = %d, want %d", c.Module, c.UserID, got, c.Bucket)
		}
	}
}

func TestResolveVectors(t *testing.T) {
	for _, c := range loadVectors(t).Resolve {
		user := ""
		if c.UserID != nil {
			user = *c.UserID
		}
		got := Resolve(toRecord(t, c.Record), user)
		want := Resolution{Version: c.Expected.Version, Channel: c.Expected.Channel, Reason: c.Expected.Reason, Bucket: c.Expected.Bucket}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: got %+v, want %+v", c.Name, got, want)
		}
	}
}

func TestTransitionVectors(t *testing.T) {
	for _, c := range loadVectors(t).Transitions {
		now, err := time.Parse(time.RFC3339Nano, c.Now)
		if err != nil {
			t.Fatal(err)
		}
		opts := TransitionOptions{By: c.By, Now: now}
		rec := toRecord(t, c.Record)
		before, _ := json.Marshal(rec)

		var out ModuleRecord
		switch c.Op {
		case "promote":
			out, err = Promote(rec, opts)
		case "rollback":
			out, err = Rollback(rec, opts)
		case "setRollout":
			n := c.Args["n"].(float64)
			if n != float64(int(n)) {
				// The int parameter rules out a fraction at compile time.
				if c.Error != string(CodeInvalidInput) {
					t.Errorf("%s: fraction should be an error case", c.Name)
				}
				continue
			}
			out, err = SetRollout(rec, int(n), opts)
		case "draftNext":
			patch, _ := c.Args["patch"].(bool)
			out, err = DraftNext(rec, c.Args["version"].(string), DraftOptions{TransitionOptions: opts, Patch: patch})
		default:
			t.Fatalf("%s: unknown op %s", c.Name, c.Op)
		}

		if c.Error != "" {
			var ve *Error
			if !errors.As(err, &ve) || string(ve.Code) != c.Error {
				t.Errorf("%s: want error %s, got %v", c.Name, c.Error, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.Name, err)
			continue
		}
		var got map[string]any
		bytes, _ := json.Marshal(out)
		_ = json.Unmarshal(bytes, &got)
		if !reflect.DeepEqual(got, c.Expected) {
			t.Errorf("%s:\n got  %v\n want %v", c.Name, got, c.Expected)
		}
		if after, _ := json.Marshal(rec); string(after) != string(before) {
			t.Errorf("%s: input record was changed", c.Name)
		}
	}
}

func TestValidationVectors(t *testing.T) {
	for _, c := range loadVectors(t).Validation {
		r := ValidateRecord(c.Record)
		if r.OK != c.OK {
			t.Errorf("%s: ok = %v, want %v (%v)", c.Name, r.OK, c.OK, r.Errors)
		}
		fields := []string{}
		for _, e := range r.Errors {
			fields = append(fields, strings.SplitN(e, " ", 2)[0])
		}
		if !reflect.DeepEqual(fields, c.Errors) {
			t.Errorf("%s: error fields %v, want %v", c.Name, fields, c.Errors)
		}
	}
}

func TestSemverVectors(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.Semver.Compare {
		got, err := CompareSemver(c.A, c.B)
		if err != nil || got != c.Expected {
			t.Errorf("CompareSemver(%q, %q) = %d, %v, want %d", c.A, c.B, got, err, c.Expected)
		}
	}
	for _, c := range v.Semver.Valid {
		if got := IsSemver(c.Value); got != c.Valid {
			t.Errorf("IsSemver(%q) = %v, want %v", c.Value, got, c.Valid)
		}
	}
}

func TestPostHogVectors(t *testing.T) {
	v := loadVectors(t)
	if len(v.Posthog) == 0 {
		t.Fatal("no posthog vectors")
	}
	for _, c := range v.Posthog {
		got, ok := RolloutFromFlag(c.Flag)
		if c.Rollout == nil {
			if ok {
				t.Errorf("%s: got %d, want no override", c.Name, got)
			}
		} else if !ok || got != *c.Rollout {
			t.Errorf("%s: got %d %v, want %d", c.Name, got, ok, *c.Rollout)
		}
	}
}
