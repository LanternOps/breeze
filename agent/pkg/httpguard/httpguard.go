// Package httpguard holds the redirect and origin rules shared by every agent
// HTTP client that sends the agent's credential to the control plane.
//
// It imports only the standard library so that low-level packages such as
// internal/logging, which internal/ech and pkg/api depend on, can use it.
package httpguard

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// MaxRedirects is the number of redirects a client built here follows before
// it stops. It matches net/http's default, which any CheckRedirect replaces.
const MaxRedirects = 10

// ErrTooManyRedirects is returned once a request has been redirected
// MaxRedirects times.
var ErrTooManyRedirects = fmt.Errorf("stopped after %d redirects", MaxRedirects)

// RefuseUntrustedRedirect is the http.Client.CheckRedirect policy for agent
// requests that carry a credential (Authorization, the re-enrollment header,
// a bootstrap token, or a token in the request body).
//
// net/http's default policy follows a redirect to any host. It drops
// Authorization only when the new host is neither the original host nor a
// subdomain of it, it keeps custom headers, and on 307/308 it sends the
// request body again. A Breeze server never redirects an agent to another
// host, so the policy refuses that outright, and the caller gets an error
// instead of a response from somewhere else.
//
// Allowed: another path on the same host, a different port on the same host,
// and an http to https upgrade. Refused: any other host (subdomains
// included), an https to http downgrade, and more than MaxRedirects hops.
// Each hop is compared with the one before it, so a chain cannot leave the
// host and come back.
func RefuseUntrustedRedirect(req *http.Request, via []*http.Request) error {
	if len(via) == 0 {
		return nil
	}
	if len(via) >= MaxRedirects {
		return ErrTooManyRedirects
	}
	prev := via[len(via)-1]
	// Hostnames are case-insensitive.
	if !strings.EqualFold(req.URL.Hostname(), prev.URL.Hostname()) {
		return fmt.Errorf("refusing redirect from host %s to untrusted host %s during credentialed request", prev.URL.Hostname(), req.URL.Hostname())
	}
	if strings.EqualFold(prev.URL.Scheme, "https") && !strings.EqualFold(req.URL.Scheme, "https") {
		return fmt.Errorf("refusing https->%s downgrade redirect to %s during credentialed request", req.URL.Scheme, req.URL.Hostname())
	}
	return nil
}

// NewClient returns an http.Client over transport (nil means
// http.DefaultTransport) with RefuseUntrustedRedirect installed. Every agent
// client that sends the agent credential is built here or installs
// RefuseUntrustedRedirect itself.
func NewClient(transport http.RoundTripper, timeout time.Duration) *http.Client {
	return &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: RefuseUntrustedRedirect}
}

// errNoOrigin is returned by origin for a URL that has no comparable origin.
var errNoOrigin = errors.New("url has no http(s) origin")

// origin returns rawURL's origin as scheme://host:port, with the scheme and
// host in lower case and the default port filled in. It refuses anything but
// an absolute http or https URL with a host, and URLs that carry userinfo.
func origin(rawURL string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return "", err
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", errNoOrigin
	}
	if u.User != nil || u.Hostname() == "" {
		return "", errNoOrigin
	}
	port := u.Port()
	if port == "" {
		port = "80"
		if scheme == "https" {
			port = "443"
		}
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", errNoOrigin
	}
	return scheme + "://" + net.JoinHostPort(strings.ToLower(u.Hostname()), strconv.Itoa(n)), nil
}

// SameOrigin reports whether a and b are absolute http(s) URLs with the same
// scheme, host and port. A URL with userinfo, no host, or another scheme has
// no origin and matches nothing.
func SameOrigin(a, b string) bool {
	oa, err := origin(a)
	if err != nil {
		return false
	}
	ob, err := origin(b)
	return err == nil && oa == ob
}
