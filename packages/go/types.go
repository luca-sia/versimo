// Package versimo resolves the last, current and next version of a module for each user.
package versimo

import "time"

// HistoryEntry is one change in a record's history.
type HistoryEntry struct {
	At     string  `json:"at"`
	Action string  `json:"action"`
	From   *string `json:"from"`
	To     *string `json:"to"`
	By     string  `json:"by,omitempty"`
}

// ModuleRecord is the release state of one module. Last and Next are nil for null.
type ModuleRecord struct {
	Schema    string         `json:"$schema,omitempty"`
	Module    string         `json:"module"`
	Last      *string        `json:"last"`
	Current   string         `json:"current"`
	Next      *string        `json:"next"`
	Rollout   int            `json:"rollout"`
	Healthy   bool           `json:"healthy"`
	UpdatedAt string         `json:"updatedAt"`
	History   []HistoryEntry `json:"history,omitempty"`
}

// Resolution says which version a user gets and why.
type Resolution struct {
	Version string
	Channel string // "next", "current" or "last"
	Reason  string // "ROLLOUT", "DEFAULT", "NO_USER" or "UNHEALTHY"
	Bucket  *int   // nil when there was no user id
}

// TransitionOptions are shared by the functions that change a record.
// A zero Now means the current time. An empty By is not recorded.
type TransitionOptions struct {
	By  string
	Now time.Time
}

// Ptr returns a pointer to v. It is handy for the Last and Next fields.
func Ptr[T any](v T) *T { return &v }
