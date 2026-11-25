package versimo

import (
	"strconv"
	"time"
)

// DraftOptions are the options of DraftNext. Patch logs the action as "patch" instead of "draft".
type DraftOptions struct {
	TransitionOptions
	Patch bool
}

// apply returns a copy of r with the changes made by change, plus a history entry.
func apply(r ModuleRecord, change func(*ModuleRecord), action string, from, to *string, o TransitionOptions) ModuleRecord {
	now := o.Now
	if now.IsZero() {
		now = time.Now()
	}
	at := now.UTC().Format("2006-01-02T15:04:05.000Z")
	entry := HistoryEntry{At: at, Action: action, From: from, To: to, By: o.By}
	out := r
	change(&out)
	out.UpdatedAt = at
	out.History = append(append([]HistoryEntry(nil), r.History...), entry)
	return out
}

// DraftNext sets a new next version at 0% rollout. It replaces any next already drafted.
func DraftNext(r ModuleRecord, version string, o DraftOptions) (ModuleRecord, error) {
	if !IsSemver(version) {
		return r, newError(CodeInvalidInput, "Invalid semver: "+version)
	}
	if mustCompare(version, r.Current) <= 0 {
		return r, newError(CodeInvalidInput, "Next "+version+" must be greater than current "+r.Current)
	}
	from := r.Current
	if r.Next != nil {
		from = *r.Next
	}
	action := "draft"
	if o.Patch {
		action = "patch"
	}
	return apply(r, func(m *ModuleRecord) { m.Next = Ptr(version); m.Rollout = 0 }, action, Ptr(from), Ptr(version), o.TransitionOptions), nil
}

// Promote moves next to current and current to last. Rollout resets to 0.
func Promote(r ModuleRecord, o TransitionOptions) (ModuleRecord, error) {
	if r.Next == nil {
		return r, newError(CodeInvalidInput, "Nothing to promote: next is empty")
	}
	next, current := *r.Next, r.Current
	return apply(r, func(m *ModuleRecord) {
		m.Last, m.Current, m.Next, m.Rollout, m.Healthy = Ptr(current), next, nil, 0, true
	}, "promote", Ptr(current), Ptr(next), o), nil
}

// Rollback puts last back as current. The failed version and any drafted next are dropped,
// so there is nothing left to roll back to until the next promote.
func Rollback(r ModuleRecord, o TransitionOptions) (ModuleRecord, error) {
	if r.Last == nil {
		return r, newError(CodeInvalidInput, "Nothing to roll back to: last is empty")
	}
	last, current := *r.Last, r.Current
	return apply(r, func(m *ModuleRecord) {
		m.Last, m.Current, m.Next, m.Rollout, m.Healthy = nil, last, nil, 0, true
	}, "rollback", Ptr(current), Ptr(last), o), nil
}

// SetRollout sets the share of users on next, an integer from 0 to 100.
func SetRollout(r ModuleRecord, n int, o TransitionOptions) (ModuleRecord, error) {
	if n < 0 || n > 100 {
		return r, newError(CodeInvalidInput, "Rollout must be an integer from 0 to 100")
	}
	if n > 0 && r.Next == nil {
		return r, newError(CodeInvalidInput, "Cannot roll out: next is empty")
	}
	return apply(r, func(m *ModuleRecord) { m.Rollout = n }, "rollout", Ptr(strconv.Itoa(r.Rollout)), Ptr(strconv.Itoa(n)), o), nil
}
