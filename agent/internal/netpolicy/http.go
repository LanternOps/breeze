// Package netpolicy is the single authority for outbound download traffic from
// the agent: updater artifacts from the control plane, and managed-software
// packages from vendor or customer-hosted origins.
//
// SECURITY: these download paths previously used a default http.Client and, at
// most, a string comparison against the configured server URL. That let a
// hostile control plane, a hostile DNS answer, or a redirect chain steer an
// authenticated agent at loopback, link-local, cloud metadata endpoints, or
// arbitrary LAN hosts, and let an environment HTTP_PROXY silently intercept
// authenticated traffic (SSRF-AGENT-001, P1-UPD-002).
//
// Enforcement here is at DIAL TIME and is authoritative. Literal URL checks
// performed by the API or by callers are defense in depth, never a substitute:
// this package assumes every URL it is handed is hostile.
//
// The defense against DNS rebinding is that the address which is validated is
// the address which is dialed. DialContext resolves once, validates the entire
// answer, and then connects to a numeric address taken from that same answer,
// so neither this package nor the standard library ever performs a second
// resolution between the check and the connect. The original hostname is
// retained as the TLS ServerName so certificate validation still binds to the
// name the caller asked for.
//
// Two classes of destination are distinguished. Universally unsafe addresses
// (loopback, link-local unicast and multicast, unspecified, multicast, and
// metadata endpoints) are never reachable and no Policy field can re-enable
// them. Private addresses (RFC1918 and IPv6 ULA) are reachable only when the
// exact, normalized request origin is a configured control-plane origin or an
// approved private origin — the configured server_url and backup_server_url may
// legitimately be private, and a customer may host managed software inside
// their own network.
//
// No decision in this package reads IS_HOSTED. The configured origins are the
// authority in hosted and self-hosted deployments alike.
//
// LOGGING: every error this package originates is a *PolicyError carrying only
// a bounded reason — no resolved address, no URL, no credential. Callers must
// log that reason (errors.As to *PolicyError, then .Reason) rather than the
// error net/http hands back, because net/http wraps every client error in a
// *url.Error whose message repeats the full request URL, capability query
// string and all.
package netpolicy

import (
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Purpose selects the scheme rules for a client. It is not a trust level: every
// purpose gets the same address enforcement.
type Purpose string

const (
	// ControlPlaneDownload fetches updater artifacts from the configured
	// control plane, which a self-hosted deployment may legitimately serve over
	// plain HTTP on a private network. Cleartext is permitted ONLY for an exact
	// ControlPlaneOrigins entry; every other host requires HTTPS.
	ControlPlaneDownload Purpose = "control_plane_download"

	// ManagedSoftwareDownload fetches installer packages from vendor CDNs or
	// customer-hosted repositories. These are attacker-influenced URLs carrying
	// executable payloads and always require HTTPS.
	ManagedSoftwareDownload Purpose = "managed_software_download"
)

// Resolver is the DNS seam. *net.Resolver satisfies it, and tests inject
// implementations that return different answers on successive calls to prove
// the dial cannot be steered by a second resolution.
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

// Policy is the complete configuration of an outbound download client.
type Policy struct {
	// Purpose selects the scheme rules. Required.
	Purpose Purpose

	// ControlPlaneOrigins are the configured server_url and backup_server_url
	// origins. They may be private addresses. Membership grants exactly two
	// things at that exact origin: reachability to a private address, and
	// (for ControlPlaneDownload) permission to use plain HTTP.
	ControlPlaneOrigins []string

	// ApprovedPrivateOrigins are organization- or site-approved origins for
	// private managed-software sources. Membership grants reachability to a
	// private address only — never a cleartext channel.
	ApprovedPrivateOrigins []string

	// MaxRedirects bounds the redirect chain. Zero or negative means the
	// default; values above maxRedirectHops are clamped down to it.
	MaxRedirects int

	// RequestTimeout bounds the whole exchange including the response body.
	// Zero or negative means defaultRequestTimeout.
	RequestTimeout time.Duration

	// MaxResponseBytes bounds a response body. Zero or negative means
	// unbounded at the transport, in which case the caller must bound the
	// transfer itself with CopyBounded.
	MaxResponseBytes int64

	// Resolver overrides DNS resolution. Nil means net.DefaultResolver.
	Resolver Resolver

	// Dialer overrides the TCP dialer. Nil means a default dialer. Its own
	// resolver is never consulted: this package only ever hands it a numeric
	// address.
	Dialer *net.Dialer

	// rawDial replaces the raw TCP connect, after every policy check has run.
	// It exists only so tests can record the address the policy chose and
	// redirect the connection to a local test server. It is unexported and
	// nothing outside this package can set it.
	rawDial func(ctx context.Context, network, addr string) (net.Conn, error)
}

const (
	// maxRedirectHops is a hard ceiling, not a default a caller can raise.
	maxRedirectHops = 10

	defaultRequestTimeout      = 5 * time.Minute
	defaultDialTimeout         = 10 * time.Second
	defaultKeepAlive           = 30 * time.Second
	defaultTLSHandshakeTimeout = 10 * time.Second
	defaultIdleConnTimeout     = 90 * time.Second
)

// ErrResponseTooLarge is returned when a response body or a CopyBounded source
// exceeds its bound. Match it with errors.Is.
var ErrResponseTooLarge = &PolicyError{Reason: ReasonResponseTooLarge}

// originContextKey carries the normalized origin of the in-flight request from
// the RoundTripper down to the dialer, which otherwise sees only host:port and
// could not tell an http origin from an https one.
type originContextKey struct{}

// NewClient builds an http.Client that enforces policy on every dial and every
// redirect hop. Configuration errors (unknown purpose, malformed origin) fail
// here rather than at request time.
func NewClient(policy Policy) (*http.Client, error) {
	if err := validatePurpose(policy.Purpose); err != nil {
		return nil, err
	}

	// Both lists grant exactly one thing: permission to reach a private
	// address at that exact origin. Neither can reach a universally unsafe
	// address.
	privateOrigins, err := newOriginSet(policy.ControlPlaneOrigins, policy.ApprovedPrivateOrigins)
	if err != nil {
		return nil, err
	}

	dialer := policy.Dialer
	if dialer == nil {
		dialer = &net.Dialer{Timeout: defaultDialTimeout, KeepAlive: defaultKeepAlive}
	}
	resolver := policy.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}

	pd := &policyDialer{
		resolver:       resolver,
		dialer:         dialer,
		privateOrigins: privateOrigins,
		rawDial:        policy.rawDial,
	}

	base := &http.Transport{
		// Rule 9: security-sensitive download clients ignore HTTP_PROXY,
		// HTTPS_PROXY and NO_PROXY. A nil Proxy is the enforcement; the
		// environment is never read.
		Proxy:                 nil,
		DialContext:           pd.DialContext,
		ForceAttemptHTTP2:     true,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout:   defaultTLSHandshakeTimeout,
		IdleConnTimeout:       defaultIdleConnTimeout,
		ExpectContinueTimeout: 1 * time.Second,
	}

	timeout := policy.RequestTimeout
	if timeout <= 0 {
		timeout = defaultRequestTimeout
	}

	return &http.Client{
		Transport:     &policyTransport{base: base, policy: policy},
		Timeout:       timeout,
		CheckRedirect: redirectPolicy(policy),
	}, nil
}

func validatePurpose(p Purpose) error {
	switch p {
	case ControlPlaneDownload, ManagedSoftwareDownload:
		return nil
	}
	return &PolicyError{Reason: ReasonInvalidPolicy}
}

// ValidateURL performs the URL-shape half of the policy: scheme, host shape,
// userinfo, port, forbidden hostnames, and IP literals that are universally
// unsafe. It deliberately performs NO DNS — resolution belongs at dial time,
// where the answer that is validated is the answer that is dialed. Callers use
// it to reject a configured or command-supplied URL early; passing it is not
// permission to reach the address behind the URL.
func ValidateURL(rawURL string, policy Policy) error {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return &PolicyError{Reason: ReasonMalformedURL}
	}
	return validateRequestURL(u, policy)
}

func validateRequestURL(u *url.URL, policy Policy) error {
	if err := validatePurpose(policy.Purpose); err != nil {
		return err
	}

	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return &PolicyError{Reason: ReasonSchemeNotAllowed}
	}

	if u.User != nil {
		return &PolicyError{Reason: ReasonUserinfoPresent}
	}

	host := normalizeHostname(u.Hostname())
	if err := checkHostShape(host); err != nil {
		return err
	}
	if isForbiddenHostname(host) {
		return &PolicyError{Reason: ReasonForbiddenHostname}
	}
	if _, err := effectivePort(scheme, u.Port()); err != nil {
		return err
	}

	// An IP literal needs no resolution, so a universally unsafe one is caught
	// here as well as at dial time. Private literals are deliberately NOT
	// decided here: whether they are reachable depends on the origin
	// allowlist, which the dial path applies.
	if a, err := netip.ParseAddr(host); err == nil && classifyAddress(a) == classForbidden {
		return &PolicyError{Reason: ReasonForbiddenAddress}
	}

	return checkCleartext(u, scheme, policy)
}

// checkCleartext implements rule 1's narrow reading: plain HTTP is permitted
// only for the CONFIGURED control plane, which a self-hosted deployment may
// legitimately serve over http on a private network. Keying the scheme on
// Purpose alone would let a hostile control plane hand the updater
// "http://attacker.example/agent.msi", or 302 an initial cleartext request
// onward to one, and have the agent fetch an executable artifact over a
// MITM-able channel. Managed software is always https, whatever is configured.
//
// It runs last because it needs a well-formed origin: a malformed host, a
// forbidden hostname or a forbidden IP literal is reported as itself.
func checkCleartext(u *url.URL, scheme string, policy Policy) error {
	if scheme == "https" {
		return nil
	}
	if policy.Purpose != ControlPlaneDownload {
		return &PolicyError{Reason: ReasonSchemeNotAllowed}
	}
	origin, err := originFromURL(u)
	if err != nil {
		return err
	}
	// Only ControlPlaneOrigins grants cleartext. ApprovedPrivateOrigins grants
	// reachability to a private address, never a downgrade of the channel.
	configured, err := newOriginSet(policy.ControlPlaneOrigins)
	if err != nil {
		return err
	}
	if !configured.contains(origin) {
		return &PolicyError{Reason: ReasonCleartextNotAllowed}
	}
	return nil
}

// policyTransport validates every outgoing request — the first one and each
// redirect hop, since each hop is a fresh RoundTrip — and publishes the
// normalized origin for the dialer. It also applies the response byte bound so
// a caller cannot forget to.
type policyTransport struct {
	base   *http.Transport
	policy Policy
}

func (t *policyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := validateRequestURL(req.URL, t.policy); err != nil {
		return nil, err
	}
	origin, err := originFromURL(req.URL)
	if err != nil {
		return nil, err
	}

	// Clone rather than mutate: a RoundTripper must not modify its argument.
	req = req.Clone(context.WithValue(req.Context(), originContextKey{}, origin))

	resp, err := t.base.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	if t.policy.MaxResponseBytes > 0 {
		resp.Body = &boundedBody{rc: resp.Body, max: t.policy.MaxResponseBytes}
	}
	return resp, nil
}

// policyDialer performs the address half of the policy.
type policyDialer struct {
	resolver       Resolver
	dialer         *net.Dialer
	privateOrigins originSet
	rawDial        func(ctx context.Context, network, addr string) (net.Conn, error)
}

// DialContext resolves the request host exactly once, validates the entire
// answer, and then connects to a numeric address drawn from that same answer.
// Handing the hostname to the underlying dialer instead would let the standard
// library resolve a second time and reintroduce the rebinding window this
// package exists to close.
func (d *policyDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, portText, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, &PolicyError{Reason: ReasonMalformedURL}
	}
	portNum, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || portNum == 0 {
		return nil, &PolicyError{Reason: ReasonInvalidPort}
	}
	port := uint16(portNum)

	h := normalizeHostname(host)
	if err := checkHostShape(h); err != nil {
		return nil, err
	}
	if isForbiddenHostname(h) {
		return nil, &PolicyError{Reason: ReasonForbiddenHostname}
	}

	// A missing origin fails closed: private addresses are then unreachable.
	origin, _ := ctx.Value(originContextKey{}).(string)
	privateAllowed := d.privateOrigins.contains(origin)

	var answer []netip.Addr
	if literal, perr := netip.ParseAddr(h); perr == nil {
		answer = []netip.Addr{literal}
	} else {
		resolved, rerr := d.resolver.LookupNetIP(ctx, lookupNetwork(network), h)
		if rerr != nil {
			return nil, &PolicyError{Reason: ReasonResolutionFailed}
		}
		answer = resolved
	}

	if err := validateResolution(answer, privateAllowed); err != nil {
		return nil, err
	}
	return d.connectValidated(ctx, network, answer, port)
}

// connectValidated dials only addresses from the validated answer. Every
// candidate has already been classified; there is no path from here back to a
// resolver.
func (d *policyDialer) connectValidated(ctx context.Context, network string, answer []netip.Addr, port uint16) (net.Conn, error) {
	var lastErr error
	for _, a := range answer {
		a = a.Unmap()
		switch network {
		case "tcp4":
			if !a.Is4() {
				continue
			}
		case "tcp6":
			if a.Is4() {
				continue
			}
		}
		conn, err := d.rawConnect(ctx, network, netip.AddrPortFrom(a, port).String())
		if err == nil {
			return conn, nil
		}
		// A dial error from the standard library names the address it tried.
		// For a private address that string must not reach a log line.
		if classifyAddress(a) == classPrivate {
			err = &PolicyError{Reason: ReasonDialFailed}
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = &PolicyError{Reason: ReasonNoAddresses}
	}
	return nil, lastErr
}

func (d *policyDialer) rawConnect(ctx context.Context, network, addr string) (net.Conn, error) {
	if d.rawDial != nil {
		return d.rawDial(ctx, network, addr)
	}
	return d.dialer.DialContext(ctx, network, addr)
}

func lookupNetwork(network string) string {
	switch network {
	case "tcp4":
		return "ip4"
	case "tcp6":
		return "ip6"
	}
	return "ip"
}

// redirectPolicy re-runs the full policy on every hop. The address checks run
// too, because each new origin means a new dial through DialContext; this
// callback covers the URL-shape, hop-count, downgrade and credential rules.
func redirectPolicy(policy Policy) func(*http.Request, []*http.Request) error {
	limit := policy.MaxRedirects
	if limit <= 0 || limit > maxRedirectHops {
		limit = maxRedirectHops
	}

	return func(req *http.Request, via []*http.Request) error {
		if len(via) > limit {
			return &PolicyError{Reason: ReasonTooManyRedirects}
		}
		if err := validateRequestURL(req.URL, policy); err != nil {
			return err
		}

		previous := via[len(via)-1]
		if strings.EqualFold(previous.URL.Scheme, "https") && !strings.EqualFold(req.URL.Scheme, "https") {
			return &PolicyError{Reason: ReasonSchemeDowngrade}
		}

		target, err := originFromURL(req.URL)
		if err != nil {
			return err
		}
		initial, err := originFromURL(via[0].URL)
		if err != nil {
			return err
		}
		if target != initial {
			// The standard library keeps these across a subdomain or port
			// change. Origin comparison here is exact, so anything that is not
			// the origin the credential was minted for loses it.
			req.Header.Del("Authorization")
			req.Header.Del("Proxy-Authorization")
			req.Header.Del("Cookie")
			req.Header.Del("Cookie2")
		}
		return nil
	}
}

// boundedBody caps a response body. It never truncates silently: crossing the
// bound is a permanent error on the body.
type boundedBody struct {
	rc      io.ReadCloser
	max     int64
	read    int64
	tripped bool
}

func (b *boundedBody) Read(p []byte) (int, error) {
	if b.tripped {
		return 0, ErrResponseTooLarge
	}
	// Read at most one byte past the bound: enough to detect the overflow,
	// never enough to buffer a large body beyond it.
	if remaining := b.max - b.read; int64(len(p)) > remaining+1 {
		p = p[:remaining+1]
	}
	n, err := b.rc.Read(p)
	b.read += int64(n)
	if b.read > b.max {
		b.tripped = true
		return 0, ErrResponseTooLarge
	}
	return n, err
}

// CloseIdleConnections keeps http.Client.CloseIdleConnections working through
// the wrapper; without it the call would silently do nothing.
func (t *policyTransport) CloseIdleConnections() { t.base.CloseIdleConnections() }

func (b *boundedBody) Close() error { return b.rc.Close() }

// CopyBounded copies src to dst, refusing to copy more than max bytes. A source
// longer than max is an error, never a silent truncation: at most max bytes
// reach dst and ErrResponseTooLarge is returned.
func CopyBounded(dst io.Writer, src io.Reader, max int64) (int64, error) {
	if max < 0 {
		return 0, &PolicyError{Reason: ReasonInvalidBound}
	}
	n, err := io.Copy(dst, io.LimitReader(src, max))
	if err != nil {
		return n, err
	}
	if n < max {
		return n, nil
	}
	// The limit was consumed exactly. One more byte distinguishes "the source
	// ended at the bound" from "the source is over the bound".
	var probe [1]byte
	extra, err := io.ReadFull(src, probe[:])
	if extra > 0 {
		return n, ErrResponseTooLarge
	}
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return n, err
	}
	return n, nil
}
