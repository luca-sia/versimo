package versimo

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ValidationResult is the outcome of ValidateRecord. Each error names the field.
type ValidationResult struct {
	OK     bool
	Errors []string
}

var (
	slugRe     = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	dateTimeRe = regexp.MustCompile(`^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?(?:Z|[+-]([0-9]{2}):([0-9]{2}))$`)
)

var (
	actions   = []string{"draft", "promote", "rollback", "rollout", "patch"}
	keys      = []string{"$schema", "module", "last", "current", "next", "rollout", "healthy", "updatedAt", "history"}
	entryKeys = []string{"at", "action", "from", "to", "by", "reason"}
)

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

func isDateTime(v any) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	m := dateTimeRe.FindStringSubmatch(s)
	if m == nil {
		return false
	}
	month, day, hour, minute, second := atoi(m[2]), atoi(m[3]), atoi(m[4]), atoi(m[5]), atoi(m[6])
	if month < 1 || month > 12 || day < 1 || day > 31 || minute > 59 || second > 59 {
		return false
	}
	// The reference implementation accepts 24:00:00 and any day up to 31.
	if hour > 24 || (hour == 24 && (minute != 0 || second != 0)) {
		return false
	}
	if m[8] != "" && (atoi(m[8]) > 23 || atoi(m[9]) > 59) {
		return false
	}
	return true
}

func isInt(v any) bool {
	f, ok := v.(float64)
	return ok && f == math.Trunc(f) && !math.IsInf(f, 0)
}

func isSemverValue(v any) bool {
	s, ok := v.(string)
	return ok && IsSemver(s)
}

func checkEntry(entry any, path string, errs *[]string) {
	e, ok := entry.(map[string]any)
	if !ok {
		*errs = append(*errs, path+" must be an object")
		return
	}
	for _, k := range sortedKeys(e) {
		if !contains(entryKeys, k) {
			*errs = append(*errs, path+"."+k+" is not allowed")
		}
	}
	if !isDateTime(e["at"]) {
		*errs = append(*errs, path+".at must be an ISO 8601 date-time")
	}
	if a, ok := e["action"].(string); !ok || !contains(actions, a) {
		*errs = append(*errs, path+".action must be one of "+strings.Join(actions, ", "))
	}
	for _, k := range []string{"from", "to"} {
		v, present := e[k]
		if _, isString := v.(string); !present || (v != nil && !isString) {
			*errs = append(*errs, path+"."+k+" must be a string or null")
		}
	}
	if by, present := e["by"]; present {
		if _, ok := by.(string); !ok {
			*errs = append(*errs, path+".by must be a string")
		}
	}
	if reason, present := e["reason"]; present {
		if _, ok := reason.(string); !ok {
			*errs = append(*errs, path+".reason must be a string")
		}
	}
}

// ValidateRecord checks a record by hand. It never panics. Each error names the field.
// Pass a decoded JSON value (map[string]any) or a ModuleRecord.
func ValidateRecord(value any) ValidationResult {
	var rec map[string]any
	switch v := value.(type) {
	case map[string]any:
		rec = v
	case nil:
		return ValidationResult{false, []string{"record must be an object"}}
	default:
		raw, err := json.Marshal(v)
		if err != nil || json.Unmarshal(raw, &rec) != nil || rec == nil {
			return ValidationResult{false, []string{"record must be an object"}}
		}
	}

	var errs []string
	for _, k := range sortedKeys(rec) {
		if !contains(keys, k) {
			errs = append(errs, k+" is not allowed")
		}
	}
	if s, present := rec["$schema"]; present {
		if _, ok := s.(string); !ok {
			errs = append(errs, "$schema must be a string")
		}
	}
	if m, ok := rec["module"].(string); !ok || !slugRe.MatchString(m) {
		errs = append(errs, `module must be a lower-case slug such as "billing" or "sign-in"`)
	}
	last, hasLast := rec["last"]
	if !hasLast || (last != nil && !isSemverValue(last)) {
		errs = append(errs, "last must be a semver string or null")
	}
	if !isSemverValue(rec["current"]) {
		errs = append(errs, "current must be a semver string")
	}
	next, hasNext := rec["next"]
	if !hasNext || (next != nil && !isSemverValue(next)) {
		errs = append(errs, "next must be a semver string or null")
	}
	rollout := rec["rollout"]
	if !isInt(rollout) || rollout.(float64) < 0 || rollout.(float64) > 100 {
		errs = append(errs, "rollout must be an integer from 0 to 100")
	}
	if _, ok := rec["healthy"].(bool); !ok {
		errs = append(errs, "healthy must be a boolean")
	}
	if !isDateTime(rec["updatedAt"]) {
		errs = append(errs, "updatedAt must be an ISO 8601 date-time")
	}
	if h, present := rec["history"]; present {
		if list, ok := h.([]any); ok {
			for i, e := range list {
				checkEntry(e, fmt.Sprintf("history[%d]", i), &errs)
			}
		} else {
			errs = append(errs, "history must be an array")
		}
	}

	if len(errs) == 0 {
		current := rec["current"].(string)
		if next != nil && mustCompare(next.(string), current) <= 0 {
			errs = append(errs, "next must be greater than current")
		}
		if last != nil && mustCompare(last.(string), current) >= 0 {
			errs = append(errs, "last must be lower than current")
		}
		if next == nil && rollout.(float64) != 0 {
			errs = append(errs, "rollout must be 0 when next is null")
		}
	}
	return ValidationResult{OK: len(errs) == 0, Errors: errs}
}

func sortedKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// ParseRecord decodes JSON into a record and validates it.
// An invalid record returns an *Error with code INVALID_RECORD.
func ParseRecord(data []byte) (ModuleRecord, error) {
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return ModuleRecord{}, &Error{Code: CodeInvalidRecord, Message: "Invalid record: " + err.Error(), Err: err}
	}
	return recordFromValue(raw, "record")
}

func recordFromValue(raw any, label string) (ModuleRecord, error) {
	if r := ValidateRecord(raw); !r.OK {
		return ModuleRecord{}, newError(CodeInvalidRecord, fmt.Sprintf("Invalid record for %q: %s", label, strings.Join(r.Errors, "; ")))
	}
	bytes, _ := json.Marshal(raw)
	var rec ModuleRecord
	if err := json.Unmarshal(bytes, &rec); err != nil {
		return ModuleRecord{}, &Error{Code: CodeInvalidRecord, Message: "Invalid record: " + err.Error(), Err: err}
	}
	return rec, nil
}
