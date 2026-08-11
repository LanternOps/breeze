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
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync/atomic"
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

// snapshot is the immutable, derived form of the two ldflag inputs (or of a
// test-seam override — see testseams.go). It is never mutated after
// construction; a new snapshot is built and swapped in wholesale, which is
// what makes concurrent reads (heartbeat loop, updater) safe without a mutex.
type snapshot struct {
	hosts  map[string]struct{}
	strict bool
}

// current holds the active snapshot. Loaded by every predicate below and
// swapped atomically by the test seams. Production code never calls Store —
// the snapshot is fixed at process start from the ldflag-injected vars.
var current atomic.Pointer[snapshot]

func init() {
	current.Store(&snapshot{
		hosts:  parseHosts(allowedHosts),
		strict: strings.TrimSpace(strictMode) != "",
	})
}

func parseHosts(raw string) map[string]struct{} {
	set := make(map[string]struct{})
	for _, h := range strings.Split(raw, ",") {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			set[h] = struct{}{}
		}
	}
	return set
}

func sortedHosts(hosts map[string]struct{}) []string {
	out := make([]string, 0, len(hosts))
	for h := range hosts {
		out = append(out, h)
	}
	sort.Strings(out)
	return out
}

// Enforced reports whether this build restricts control-plane hosts (hosted mode,
// gap OR strict).
func Enforced() bool { return len(current.Load().hosts) > 0 }

// Strict reports whether existing-fleet violations hard-fail (the strict build).
// False in a gap build (allowlist set, strictMode empty) and in self-host.
func Strict() bool {
	s := current.Load()
	return len(s.hosts) > 0 && s.strict
}

// Mode returns "hosted-strict", "hosted-gap", or "self-host", for logging.
func Mode() string {
	s := current.Load()
	if len(s.hosts) == 0 {
		return "self-host"
	}
	if s.strict {
		return "hosted-strict"
	}
	return "hosted-gap"
}

// Hosts returns the sorted allowlist (empty in self-host), for error/log text.
func Hosts() []string {
	return sortedHosts(current.Load().hosts)
}

// AllowedHost reports whether host (bare hostname, no port) is permitted.
// Self-host permits everything. Matching is exact and case-insensitive — there is
// deliberately NO wildcard/suffix logic, so "hosted-a.example.evil.com" never matches
// an allowlisted "hosted-a.example".
func AllowedHost(host string) bool {
	s := current.Load()
	if len(s.hosts) == 0 {
		return true
	}
	_, ok := s.hosts[strings.ToLower(strings.TrimSpace(host))]
	return ok
}

// AllowedURL parses rawURL and checks its hostname (port stripped). Returns nil
// when allowed or in self-host mode. In hosted mode a malformed URL is refused.
// The returned error is safe to surface/log: it names only the offending host and
// the allowlist, never a token or secret.
func AllowedURL(rawURL string) error {
	s := current.Load()
	if len(s.hosts) == 0 {
		return nil
	}
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Host == "" {
		// Deliberately does NOT echo rawURL: a malformed URL may embed a
		// token or query string, and this error is documented as safe to
		// surface/log verbatim.
		return errors.New("hosted build: control-plane URL is not a parseable URL")
	}
	host := strings.ToLower(strings.TrimSpace(u.Hostname()))
	if _, ok := s.hosts[host]; !ok {
		return fmt.Errorf("hosted build refuses control-plane host %q (allowed: %s)",
			u.Hostname(), strings.Join(sortedHosts(s.hosts), ", "))
	}
	return nil
}
