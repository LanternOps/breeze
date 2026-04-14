package collectors

import (
	"errors"
	"os"
	"strings"
)

// errHostnameResolutionFailed is returned by resolveHostname when every
// source in the platform chain yielded an empty value. Callers (notably
// the enroll path) must fail loudly instead of substituting a synthetic
// identifier — see issue #439.
var errHostnameResolutionFailed = errors.New("hostname resolution failed: all sources empty")

// hostnameSource produces a single candidate hostname. A return value
// that is empty or whitespace-only means "this source had nothing
// useful" and the next source is tried.
type hostnameSource func() string

// resolveHostname walks the platform-specific source chain and returns
// the first non-empty, trimmed value. It deliberately NEVER substitutes
// a device UUID, agent token, or any other synthetic identifier — if
// every source is empty the caller gets an error and is expected to
// abort whatever it was doing (e.g. enrollment).
func resolveHostname() (string, error) {
	return resolveHostnameFromSources(hostnameSourceChain())
}

// resolveHostnameFromSources is the pure core of the resolver, exposed
// so hostname_test.go can exercise the chain logic without touching the
// real OS. Each source is called in order; the first trimmed non-empty
// return wins. Nil sources are skipped.
func resolveHostnameFromSources(sources []hostnameSource) (string, error) {
	for _, src := range sources {
		if src == nil {
			continue
		}
		if name := strings.TrimSpace(src()); name != "" {
			return name, nil
		}
	}
	return "", errHostnameResolutionFailed
}

// hostnameSourceChain is os.Hostname() followed by the platform-specific
// fallbacks declared in hostname_<os>.go files.
func hostnameSourceChain() []hostnameSource {
	chain := []hostnameSource{osHostname}
	chain = append(chain, platformHostnameFallbacks()...)
	return chain
}

// osHostname wraps os.Hostname() so it satisfies the hostnameSource
// signature and swallows its error (an error from os.Hostname is
// indistinguishable from "empty" for our purposes — the next source
// should still be tried).
func osHostname() string {
	name, err := os.Hostname()
	if err != nil {
		return ""
	}
	return name
}
