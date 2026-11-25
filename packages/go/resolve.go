package versimo

// Resolve works out which version of the module this user gets, and why.
// An empty userID means there is no user.
func Resolve(r ModuleRecord, userID string) Resolution {
	if !r.Healthy {
		if r.Last != nil {
			return Resolution{Version: *r.Last, Channel: "last", Reason: "UNHEALTHY"}
		}
		return Resolution{Version: r.Current, Channel: "current", Reason: "UNHEALTHY"}
	}
	if userID == "" {
		return Resolution{Version: r.Current, Channel: "current", Reason: "NO_USER"}
	}
	bucket := BucketFor(r.Module, userID)
	if r.Next != nil && bucket < r.Rollout {
		return Resolution{Version: *r.Next, Channel: "next", Reason: "ROLLOUT", Bucket: &bucket}
	}
	return Resolution{Version: r.Current, Channel: "current", Reason: "DEFAULT", Bucket: &bucket}
}

// ResolveVersion is Resolve without the explanation.
func ResolveVersion(r ModuleRecord, userID string) string {
	return Resolve(r, userID).Version
}
