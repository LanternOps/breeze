// Package versionpolicy is the single authority for update-precedence
// decisions across the agent, the desktop/user helper, and the watchdog.
//
// SECURITY: this package exists because a hand-rolled numeric-tuple version
// parser mis-orders SemVer prerelease and build-metadata segments (e.g. it
// treats "0.69.0-rc1" as equal to "0.69.0"), which lets a hostile or buggy
// control plane direct an agent to "upgrade" from a stable release to an
// attacker-chosen prerelease, or feed a malformed target the old parser
// accepted. Decide is now the only place that reasons about version
// precedence for update directives; callers must not reimplement any part of
// this comparison.
package versionpolicy

import (
	"strings"

	"golang.org/x/mod/semver"
)

// CurrentPolicy selects how Decide treats the "current" (installed) side of
// an update decision. The three shapes in the fleet — the main agent's own
// running binary, an installed sidecar component (helper, watchdog), and a
// component not yet installed — have different fail-closed postures.
type CurrentPolicy uint8

const (
	// MainAgentCurrent is the agent evaluating its own self-update. It is the
	// only policy granted the "dev" build development-compatibility
	// exception: a non-release agent build reports its version as the
	// literal string "dev", which is not a SemVer, but a dev build must
	// still be able to move onto a real release.
	MainAgentCurrent CurrentPolicy = iota

	// InstalledComponentCurrent is a sidecar component (helper, watchdog)
	// known to be present, whose reported "current" version must be a valid
	// SemVer or the decision fails closed. This also covers the case where
	// the component is on disk but its version could not be read: the
	// caller passes an empty/unreadable current string, which is malformed
	// and denies — an unreadable installed component must NOT be treated as
	// a fresh install that accepts any target.
	InstalledComponentCurrent

	// AbsentComponentCurrent is a sidecar component confirmed absent from
	// disk (a genuine fresh install). Any valid target is allowed regardless
	// of what the caller passes as "current".
	AbsentComponentCurrent
)

// Decision is the outcome of an update-precedence check.
type Decision struct {
	Allowed bool
	Reason  string
}

// Reason strings are bounded constants — callers must not invent new reasons
// or attach free-form text, since these values are surfaced in structured
// security logs.
const (
	ReasonInvalidTarget      = "invalid_target"
	ReasonDevelopmentCurrent = "development_current"
	ReasonInvalidCurrent     = "invalid_current"
	ReasonFreshInstall       = "fresh_install"
	ReasonDowngrade          = "downgrade"
	ReasonSameOrUpgrade      = "same_or_upgrade"
)

// mainAgentDevBuild is the literal version string a non-release agent build
// reports. It is not a SemVer and is recognized only for MainAgentCurrent.
const mainAgentDevBuild = "dev"

// Normalize trims surrounding whitespace, permits exactly one optional
// lowercase "v" prefix (adding one when absent, e.g. "1.2.3" -> "v1.2.3"),
// and accepts only strings golang.org/x/mod/semver considers valid —
// canonical SemVer with no leading zeroes and no extra dot-separated
// segments. Prerelease and build-metadata suffixes are preserved verbatim so
// callers compare full SemVer precedence, not a truncated release line.
func Normalize(raw string) (string, bool) {
	v := strings.TrimSpace(raw)
	if v == "" {
		return "", false
	}
	if !strings.HasPrefix(v, "v") {
		v = "v" + v
	}
	if !semver.IsValid(v) {
		return "", false
	}
	return v, true
}

// Decide is the single authority for whether an update directive from target
// to current should proceed, given policy. Malformed target values always
// fail closed regardless of policy. Only MainAgentCurrent with a current of
// exactly "dev" receives the development-compatibility exception; every
// other malformed current fails closed except AbsentComponentCurrent, which
// allows any valid target as a fresh install. Otherwise the decision is a
// straight SemVer precedence comparison: strictly lower denies as a
// downgrade, equal or higher allows.
func Decide(target, current string, policy CurrentPolicy) Decision {
	t, ok := Normalize(target)
	if !ok {
		return Decision{Allowed: false, Reason: ReasonInvalidTarget}
	}

	if policy == MainAgentCurrent && strings.TrimSpace(current) == mainAgentDevBuild {
		return Decision{Allowed: true, Reason: ReasonDevelopmentCurrent}
	}

	if policy == AbsentComponentCurrent {
		return Decision{Allowed: true, Reason: ReasonFreshInstall}
	}

	c, ok := Normalize(current)
	if !ok {
		return Decision{Allowed: false, Reason: ReasonInvalidCurrent}
	}

	if semver.Compare(t, c) < 0 {
		return Decision{Allowed: false, Reason: ReasonDowngrade}
	}
	return Decision{Allowed: true, Reason: ReasonSameOrUpgrade}
}
