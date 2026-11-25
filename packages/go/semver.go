package versimo

import (
	"regexp"
	"strings"
)

const ident = `(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)`

// SemverPattern is the same expression the JSON Schema uses.
const SemverPattern = `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)` +
	`(?:-(` + ident + `(?:\.` + ident + `)*))?` +
	`(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$`

var semverRe = regexp.MustCompile(SemverPattern)

// IsSemver reports whether s is a valid semver string.
func IsSemver(s string) bool { return semverRe.MatchString(s) }

type semver struct {
	core [3]string
	pre  []string
}

func parseSemver(s string) (semver, bool) {
	m := semverRe.FindStringSubmatch(s)
	if m == nil {
		return semver{}, false
	}
	v := semver{core: [3]string{m[1], m[2], m[3]}}
	if m[4] != "" {
		v.pre = strings.Split(m[4], ".")
	}
	return v, true
}

func isNumeric(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// Numbers have no leading zeros, so length then text compares exactly, with no overflow.
func cmpNumeric(a, b string) int {
	if len(a) != len(b) {
		if len(a) < len(b) {
			return -1
		}
		return 1
	}
	return strings.Compare(a, b)
}

// CompareSemver returns -1, 0 or 1. Build metadata is ignored.
// It returns an error when either version is not valid semver.
func CompareSemver(a, b string) (int, error) {
	x, ok := parseSemver(a)
	if !ok {
		return 0, newError(CodeInvalidInput, "Invalid semver: "+a)
	}
	y, ok := parseSemver(b)
	if !ok {
		return 0, newError(CodeInvalidInput, "Invalid semver: "+b)
	}
	return compareParsed(x, y), nil
}

func compareParsed(x, y semver) int {
	for i := 0; i < 3; i++ {
		if c := cmpNumeric(x.core[i], y.core[i]); c != 0 {
			return c
		}
	}
	if len(x.pre) == 0 && len(y.pre) == 0 {
		return 0
	}
	if len(x.pre) == 0 {
		return 1
	}
	if len(y.pre) == 0 {
		return -1
	}
	for i := 0; i < len(x.pre) || i < len(y.pre); i++ {
		if i >= len(x.pre) {
			return -1
		}
		if i >= len(y.pre) {
			return 1
		}
		p, q := x.pre[i], y.pre[i]
		if p == q {
			continue
		}
		pn, qn := isNumeric(p), isNumeric(q)
		switch {
		case pn && qn:
			return cmpNumeric(p, q)
		case pn:
			return -1
		case qn:
			return 1
		default:
			return strings.Compare(p, q)
		}
	}
	return 0
}

// mustCompare is for versions already known to be valid.
func mustCompare(a, b string) int {
	c, _ := CompareSemver(a, b)
	return c
}
