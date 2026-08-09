// Package hostpolicy enforces the compile-time control-plane host allowlist that
// distinguishes a "hosted" Breeze build (may only contact Breeze-operated
// control planes) from a "self-host" build (unrestricted).
//
// The allowlist is injected at build time via:
//
//	-ldflags "-X github.com/breeze-rmm/agent/internal/hostpolicy.allowedHosts=host1,host2"
//
// An EMPTY allowedHosts (the repo default) means self-host mode: no restriction,
// identical to historical behavior — so this control is inert until a build opts
// into hosted mode. Never commit a non-empty value; infra hostnames stay out of
// source (see CLAUDE.md "No Internal Infrastructure Details").
package hostpolicy

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
)

// allowedHosts is the ldflag-injected, comma-separated list of exact,
// case-insensitive control-plane hostnames a hosted build may contact.
// Empty => self-host (unrestricted).
var allowedHosts = ""

// strictMode is ldflag-injected ("1"/"true"/anything non-empty => strict).
// Empty (repo default, and the gap build) => warn mode: existing-fleet
// violations are detected and reported rather than hard-failed. Meaningless
// without allowedHosts.
//
//	-ldflags "-X github.com/breeze-rmm/agent/internal/hostpolicy.strictMode=1"
var strictMode = ""

// parsed is the normalized allowlist set, (re)computed from allowedHosts.
var parsed = parseHosts(allowedHosts)

// strict is the normalized strict flag, (re)computed from strictMode.
var strict = strings.TrimSpace(strictMode) != ""

func parseHosts(raw string) map[string]struct{} {
	set := make(map[string]struct{})
	for _, h := range strings.Split(raw, ",") {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			set[h] = struct{}{}
		}
	}
	return set
}

// Enforced reports whether this build restricts control-plane hosts (hosted mode,
// gap OR strict).
func Enforced() bool { return len(parsed) > 0 }

// Strict reports whether existing-fleet violations hard-fail (the strict build).
// False in a gap build (allowlist set, strictMode empty) and in self-host.
func Strict() bool { return Enforced() && strict }

// Mode returns "hosted-strict", "hosted-gap", or "self-host", for logging.
func Mode() string {
	if !Enforced() {
		return "self-host"
	}
	if strict {
		return "hosted-strict"
	}
	return "hosted-gap"
}

// Hosts returns the sorted allowlist (empty in self-host), for error/log text.
func Hosts() []string {
	out := make([]string, 0, len(parsed))
	for h := range parsed {
		out = append(out, h)
	}
	sort.Strings(out)
	return out
}

// AllowedHost reports whether host (bare hostname, no port) is permitted.
// Self-host permits everything. Matching is exact and case-insensitive — there is
// deliberately NO wildcard/suffix logic, so "hosted-a.example.evil.com" never matches
// an allowlisted "hosted-a.example".
func AllowedHost(host string) bool {
	if !Enforced() {
		return true
	}
	_, ok := parsed[strings.ToLower(strings.TrimSpace(host))]
	return ok
}

// AllowedURL parses rawURL and checks its hostname (port stripped). Returns nil
// when allowed or in self-host mode. In hosted mode a malformed URL is refused.
// The returned error is safe to surface/log: it names only the offending host and
// the allowlist, never a token or secret.
func AllowedURL(rawURL string) error {
	if !Enforced() {
		return nil
	}
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Host == "" {
		return fmt.Errorf("hosted build: control-plane URL %q is not a parseable https URL", rawURL)
	}
	if !AllowedHost(u.Hostname()) {
		return fmt.Errorf("hosted build refuses control-plane host %q (allowed: %s)",
			u.Hostname(), strings.Join(Hosts(), ", "))
	}
	return nil
}

// SetAllowedHostsForTest overrides the compiled allowlist at runtime for TESTS
// ONLY and returns a restore func. Not safe for production use (mutates package
// state without synchronization).
func SetAllowedHostsForTest(csv string) (restore func()) {
	prev := parsed
	parsed = parseHosts(csv)
	return func() { parsed = prev }
}

// SetStrictModeForTest overrides strict mode at runtime for TESTS ONLY and
// returns a restore func. Not safe for production use (mutates package state
// without synchronization).
func SetStrictModeForTest(on bool) (restore func()) {
	prev := strict
	strict = on
	return func() { strict = prev }
}
