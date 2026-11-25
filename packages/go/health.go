package versimo

import (
	"math"
	"strings"
)

// HealthActor is recorded as By in history when the caller gives no name.
const HealthActor = "versimo-health"

// HealthChecks are the limits for one module. A nil field turns that check off.
type HealthChecks struct {
	// MaxErrorRate is the highest share of failed requests, from 0 to 1.
	MaxErrorRate *float64 `json:"maxErrorRate,omitempty"`
	// MaxLatencyMs is the highest latency in milliseconds, usually p95.
	MaxLatencyMs *float64 `json:"maxLatencyMs,omitempty"`
	// URL must answer with a 2xx status.
	URL *string `json:"url,omitempty"`
	// MinRequests is how many requests are needed before the error rate is judged. Default 1.
	MinRequests *int `json:"minRequests,omitempty"`
}

// HealthObservation is what was measured for current. A nil field skips that check.
type HealthObservation struct {
	Requests  *int     `json:"requests,omitempty"`
	Errors    *int     `json:"errors,omitempty"`
	LatencyMs *float64 `json:"latencyMs,omitempty"`
	// URLStatus is the HTTP status of the check URL. 0 means it could not be reached.
	URLStatus *int `json:"urlStatus,omitempty"`
}

// HealthFailure is one failed check. Limit is nil for the URL check.
type HealthFailure struct {
	Check string   `json:"check"`
	Value float64  `json:"value"`
	Limit *float64 `json:"limit"`
}

// HealthVerdict lists the failed checks, always in the order errorRate, latency, url.
type HealthVerdict struct {
	Healthy  bool            `json:"healthy"`
	Failures []HealthFailure `json:"failures"`
}

// HealthResult is the record after the check, the verdict, and whether it rolled back.
type HealthResult struct {
	Record     ModuleRecord  `json:"record"`
	Verdict    HealthVerdict `json:"verdict"`
	RolledBack bool          `json:"rolledBack"`
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func checkHealthInputs(c HealthChecks, o HealthObservation) error {
	bad := func(msg string) error { return newError(CodeInvalidInput, msg) }
	if v := c.MaxErrorRate; v != nil && (!finite(*v) || *v < 0 || *v > 1) {
		return bad("maxErrorRate must be a number from 0 to 1")
	}
	if v := c.MaxLatencyMs; v != nil && (!finite(*v) || *v < 0) {
		return bad("maxLatencyMs must be a number of 0 or more")
	}
	if c.URL != nil && *c.URL == "" {
		return bad("url must be a non-empty string")
	}
	if c.MinRequests != nil && *c.MinRequests < 0 {
		return bad("minRequests must be an integer of 0 or more")
	}
	if o.Requests != nil && *o.Requests < 0 {
		return bad("requests must be an integer of 0 or more")
	}
	if o.Errors != nil && *o.Errors < 0 {
		return bad("errors must be an integer of 0 or more")
	}
	if o.Errors != nil && o.Requests != nil && *o.Errors > *o.Requests {
		return bad("errors cannot be more than requests")
	}
	if v := o.LatencyMs; v != nil && (!finite(*v) || *v < 0) {
		return bad("latencyMs must be a number of 0 or more")
	}
	if o.URLStatus != nil && *o.URLStatus < 0 {
		return bad("urlStatus must be an integer of 0 or more")
	}
	return nil
}

// EvaluateHealth judges one observation against the checks. It is the same in every language.
func EvaluateHealth(c HealthChecks, o HealthObservation) (HealthVerdict, error) {
	if err := checkHealthInputs(c, o); err != nil {
		return HealthVerdict{}, err
	}
	failures := []HealthFailure{}
	if c.MaxErrorRate != nil && o.Requests != nil && o.Errors != nil {
		need := 1
		if c.MinRequests != nil && *c.MinRequests > 1 {
			need = *c.MinRequests
		}
		if *o.Requests >= need {
			rate := float64(*o.Errors) / float64(*o.Requests)
			if rate > *c.MaxErrorRate {
				failures = append(failures, HealthFailure{Check: "errorRate", Value: rate, Limit: Ptr(*c.MaxErrorRate)})
			}
		}
	}
	if c.MaxLatencyMs != nil && o.LatencyMs != nil && *o.LatencyMs > *c.MaxLatencyMs {
		failures = append(failures, HealthFailure{Check: "latency", Value: *o.LatencyMs, Limit: Ptr(*c.MaxLatencyMs)})
	}
	if c.URL != nil && o.URLStatus != nil && (*o.URLStatus < 200 || *o.URLStatus > 299) {
		failures = append(failures, HealthFailure{Check: "url", Value: float64(*o.URLStatus)})
	}
	return HealthVerdict{Healthy: len(failures) == 0, Failures: failures}, nil
}

// CheckHealth judges current and, when it fails, steps back to last on its own.
// The rollback is recorded in history with the failed checks as the reason,
// for example "health: errorRate, latency". With no last the record is left
// as it is and only the verdict says it failed.
func CheckHealth(r ModuleRecord, c HealthChecks, o HealthObservation, opts TransitionOptions) (HealthResult, error) {
	verdict, err := EvaluateHealth(c, o)
	if err != nil {
		return HealthResult{Record: r}, err
	}
	if verdict.Healthy || r.Last == nil {
		return HealthResult{Record: r, Verdict: verdict}, nil
	}
	names := make([]string, len(verdict.Failures))
	for i, f := range verdict.Failures {
		names[i] = f.Check
	}
	if opts.By == "" {
		opts.By = HealthActor
	}
	opts.Reason = "health: " + strings.Join(names, ", ")
	out, err := Rollback(r, opts)
	if err != nil {
		return HealthResult{Record: r, Verdict: verdict}, err
	}
	return HealthResult{Record: out, Verdict: verdict, RolledBack: true}, nil
}
