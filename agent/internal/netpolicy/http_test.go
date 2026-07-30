package netpolicy

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

// stubResolver returns scripted answers per hostname. Successive lookups of the
// same host walk the scripted list, so a test can hand out a safe answer first
// and a hostile one second — the rebinding case.
type stubResolver struct {
	mu    sync.Mutex
	seq   map[string][][]netip.Addr
	calls map[string]int
}

func newStubResolver() *stubResolver {
	return &stubResolver{seq: map[string][][]netip.Addr{}, calls: map[string]int{}}
}

func (r *stubResolver) set(host string, answers ...[]netip.Addr) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seq[host] = answers
}

func (r *stubResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	answers, ok := r.seq[host]
	if !ok || len(answers) == 0 {
		return nil, fmt.Errorf("stub resolver: no answer for %q", host)
	}
	i := r.calls[host]
	r.calls[host]++
	if i >= len(answers) {
		i = len(answers) - 1
	}
	return answers[i], nil
}

func (r *stubResolver) callCount(host string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls[host]
}

// dialRecorder records the address the policy asked to connect to and then
// connects to the local test server instead. Recording the requested address is
// what proves the dial used a validated address rather than a hostname (which
// the stdlib would re-resolve) or a second resolution.
type dialRecorder struct {
	mu    sync.Mutex
	addrs []string
	to    string
}

func (d *dialRecorder) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	d.mu.Lock()
	d.addrs = append(d.addrs, addr)
	to := d.to
	d.mu.Unlock()
	return (&net.Dialer{}).DialContext(ctx, network, to)
}

func (d *dialRecorder) dialed() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.addrs...)
}

func newHarness(t *testing.T, h http.Handler) (*stubResolver, *dialRecorder) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return newStubResolver(), &dialRecorder{to: srv.Listener.Addr().String()}
}

func mustClient(t *testing.T, p Policy) *http.Client {
	t.Helper()
	c, err := NewClient(p)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c
}

func baseTransport(t *testing.T, c *http.Client) *http.Transport {
	t.Helper()
	pt, ok := c.Transport.(*policyTransport)
	if !ok {
		t.Fatalf("client transport is %T, want *policyTransport", c.Transport)
	}
	return pt.base
}

// get performs a GET and always releases the body, including the redirect-error
// case where net/http returns both a response and an error.
func get(c *http.Client, url string) (int, string, error) {
	resp, err := c.Get(url)
	if resp != nil {
		body, readErr := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if err == nil && readErr != nil {
			err = readErr
		}
		return resp.StatusCode, string(body), err
	}
	return 0, "", err
}

func publicAddrs(t *testing.T, ss ...string) []netip.Addr { return mustAddrs(t, ss...) }

// ---------------------------------------------------------------------------
// policy / URL validation
// ---------------------------------------------------------------------------

func TestNewClientRejectsInvalidPolicy(t *testing.T) {
	if _, err := NewClient(Policy{Purpose: "sideload"}); err == nil {
		t.Fatal("NewClient accepted an unknown purpose")
	} else {
		assertReason(t, err, ReasonInvalidPolicy)
	}

	_, err := NewClient(Policy{
		Purpose:             ControlPlaneDownload,
		ControlPlaneOrigins: []string{"https://ok.example", "gopher://bad.example"},
	})
	assertReason(t, err, ReasonInvalidOrigin)

	_, err = NewClient(Policy{
		Purpose:                ManagedSoftwareDownload,
		ApprovedPrivateOrigins: []string{"https://user:pw@repo.example"},
	})
	assertReason(t, err, ReasonInvalidOrigin)
}

func TestValidateURL(t *testing.T) {
	tests := []struct {
		name       string
		raw        string
		purpose    Purpose
		origins    []string
		wantReason string // "" means accept
	}{
		{"control plane https", "https://cdn.example/file.bin", ControlPlaneDownload, nil, ""},
		// Cleartext is permitted only for an EXACT configured control-plane
		// origin — keying it on Purpose alone would let a hostile control plane
		// name any host and get an executable artifact over a MITM-able channel.
		{"control plane http to configured origin", "http://breeze.lan:8080/file.bin", ControlPlaneDownload,
			[]string{"http://breeze.lan:8080"}, ""},
		{"control plane http to unconfigured host", "http://attacker.example/agent.msi", ControlPlaneDownload,
			[]string{"http://breeze.lan:8080"}, ReasonCleartextNotAllowed},
		{"control plane http with no origins configured", "http://breeze.lan:8080/file.bin", ControlPlaneDownload,
			nil, ReasonCleartextNotAllowed},
		{"control plane http to lookalike of configured origin", "http://evil.breeze.lan:8080/x", ControlPlaneDownload,
			[]string{"http://breeze.lan:8080"}, ReasonCleartextNotAllowed},
		{"control plane http on a different port", "http://breeze.lan:9090/x", ControlPlaneDownload,
			[]string{"http://breeze.lan:8080"}, ReasonCleartextNotAllowed},
		{"managed software https", "https://cdn.example/app.msi", ManagedSoftwareDownload, nil, ""},
		{"managed software http rejected", "http://cdn.example/app.msi", ManagedSoftwareDownload, nil, ReasonSchemeNotAllowed},
		// A control-plane origin never downgrades managed software.
		{"managed software http to a control plane origin", "http://breeze.lan:8080/app.msi", ManagedSoftwareDownload,
			[]string{"http://breeze.lan:8080"}, ReasonSchemeNotAllowed},
		{"file scheme", "file:///etc/shadow", ControlPlaneDownload, nil, ReasonSchemeNotAllowed},
		{"gopher scheme", "gopher://cdn.example/x", ControlPlaneDownload, nil, ReasonSchemeNotAllowed},
		{"relative url", "/just/a/path", ControlPlaneDownload, nil, ReasonSchemeNotAllowed},
		{"empty host", "https:///file.bin", ControlPlaneDownload, nil, ReasonEmptyHost},
		{"userinfo", "https://user:pw@cdn.example/f", ControlPlaneDownload, nil, ReasonUserinfoPresent},
		{"userinfo without password", "https://user@cdn.example/f", ControlPlaneDownload, nil, ReasonUserinfoPresent},
		{"port zero", "https://cdn.example:0/f", ControlPlaneDownload, nil, ReasonInvalidPort},
		{"port too large", "https://cdn.example:99999/f", ControlPlaneDownload, nil, ReasonInvalidPort},
		{"mapped ipv4 literal", "https://[::ffff:127.0.0.1]/f", ControlPlaneDownload, nil, ReasonAmbiguousIPEncoding},
		{"decimal ipv4 literal", "https://2130706433/f", ControlPlaneDownload, nil, ReasonAmbiguousIPEncoding},
		{"octal ipv4 literal", "https://0177.0.0.1/f", ControlPlaneDownload, nil, ReasonAmbiguousIPEncoding},
		{"empty label", "https://host..example/f", ControlPlaneDownload, nil, ReasonInvalidHostname},
		// The named-hostname and forbidden-literal controls report themselves,
		// not the cleartext rule: the cleartext gate runs last.
		{"gcp metadata hostname", "http://metadata.google.internal/computeMetadata/v1/", ControlPlaneDownload, nil, ReasonForbiddenHostname},
		{"gcp metadata hostname trailing dot", "http://metadata.google.internal./x", ControlPlaneDownload, nil, ReasonForbiddenHostname},
		{"gcp metadata hostname extra dots", "http://metadata.google.internal../x", ControlPlaneDownload, nil, ReasonForbiddenHostname},
		// Shape only: the address checks happen at dial time, but a literal
		// loopback URL has nothing to resolve so it is caught here too.
		{"loopback literal", "http://127.0.0.1:8080/f", ControlPlaneDownload, nil, ReasonForbiddenAddress},
		{"ipv6 loopback literal", "http://[::1]:8080/f", ControlPlaneDownload, nil, ReasonForbiddenAddress},
		{"metadata literal", "http://169.254.169.254/latest/meta-data/", ControlPlaneDownload, nil, ReasonForbiddenAddress},
		{"cgnat literal is not forbidden by shape", "https://100.64.1.2/f", ControlPlaneDownload, nil, ""},
		{"reserved literal", "http://240.1.2.3/f", ControlPlaneDownload, nil, ReasonForbiddenAddress},
		{"broadcast literal", "http://255.255.255.255/f", ControlPlaneDownload, nil, ReasonForbiddenAddress},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateURL(tt.raw, Policy{Purpose: tt.purpose, ControlPlaneOrigins: tt.origins})
			if tt.wantReason == "" {
				if err != nil {
					t.Fatalf("ValidateURL(%q) = %v, want nil", tt.raw, err)
				}
				return
			}
			assertReason(t, err, tt.wantReason)
		})
	}
}

// An approved private origin makes a private ADDRESS reachable. It never
// downgrades the channel to cleartext.
func TestApprovedPrivateOriginDoesNotGrantCleartext(t *testing.T) {
	p := Policy{
		Purpose:                ControlPlaneDownload,
		ApprovedPrivateOrigins: []string{"http://repo.lan"},
	}
	assertReason(t, ValidateURL("http://repo.lan/file.bin", p), ReasonCleartextNotAllowed)

	p.Purpose = ManagedSoftwareDownload
	assertReason(t, ValidateURL("http://repo.lan/app.msi", p), ReasonSchemeNotAllowed)
}

// A cleartext control-plane request must not be a springboard: the redirect
// target is a separate origin and needs its own cleartext permission.
func TestRedirectCleartextOffTheControlPlaneRejected(t *testing.T) {
	res, rec := newHarness(t, redirectHandler())
	res.set("breeze.lan", publicAddrs(t, "203.0.113.10"))
	res.set("attacker.example", publicAddrs(t, "203.0.113.20"))
	p := testPolicy(res, rec)
	p.ControlPlaneOrigins = []string{"http://breeze.lan:8080"}
	c := mustClient(t, p)

	_, _, err := get(c, "http://breeze.lan:8080/to?u=http://attacker.example/hop/0")
	assertReason(t, err, ReasonCleartextNotAllowed)
	if want := []string{"203.0.113.10:8080"}; !equalStrings(rec.dialed(), want) {
		t.Fatalf("dialed %v, want only the control-plane hop %v", rec.dialed(), want)
	}
}

// ValidateURL is also used while parsing configuration, where a DNS round trip
// would be both a hang risk and a TOCTOU trap. Resolution belongs at dial time.
func TestValidateURLDoesNotResolve(t *testing.T) {
	r := &explodingResolver{t: t}
	p := Policy{Purpose: ManagedSoftwareDownload, Resolver: r}
	if err := ValidateURL("https://cdn.example/app.msi", p); err != nil {
		t.Fatalf("ValidateURL: %v", err)
	}
	if err := ValidateURL("https://10.0.0.5/app.msi", p); err != nil {
		t.Fatalf("ValidateURL on a private literal should defer to dial time, got %v", err)
	}
}

type explodingResolver struct{ t *testing.T }

func (r *explodingResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	r.t.Error("resolver must not be used outside the dial path")
	return nil, errors.New("resolver must not be called")
}

// ---------------------------------------------------------------------------
// dial-time address enforcement
// ---------------------------------------------------------------------------

func TestClientRejectsUnsafeInitialTarget(t *testing.T) {
	unsafe := map[string]string{
		"loopback":              "127.0.0.1",
		"ipv6 loopback":         "::1",
		"mapped loopback":       "::ffff:127.0.0.1",
		"link-local":            "169.254.10.10",
		"imds":                  "169.254.169.254",
		"ecs task metadata":     "169.254.170.2",
		"alibaba metadata":      "100.100.100.200",
		"unspecified":           "0.0.0.0",
		"multicast":             "224.0.0.251",
		"6to4 wrapped loopback": "2002:7f00:1::",
	}

	for name, addr := range unsafe {
		t.Run(name, func(t *testing.T) {
			res, rec := newHarness(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Error("server must never be reached")
			}))
			res.set("cdn.example", publicAddrs(t, addr))
			c := mustClient(t, testPolicy(res, rec))

			_, _, err := get(c, "http://cdn.example/file.bin")
			assertReason(t, err, ReasonForbiddenAddress)
			if dialed := rec.dialed(); len(dialed) != 0 {
				t.Fatalf("policy dialed %v; nothing must be dialed after a forbidden answer", dialed)
			}
		})
	}
}

// A hostile answer anywhere in the set poisons the whole answer, so an attacker
// cannot win by racing a good address against a bad one.
func TestClientRejectsMixedPublicAndUnsafeAnswer(t *testing.T) {
	res, rec := newHarness(t, okHandler())
	res.set("cdn.example", publicAddrs(t, "203.0.113.10", "169.254.169.254"))
	c := mustClient(t, testPolicy(res, rec))

	_, _, err := get(c, "http://cdn.example/file.bin")
	assertReason(t, err, ReasonForbiddenAddress)
	if dialed := rec.dialed(); len(dialed) != 0 {
		t.Fatalf("policy dialed %v; nothing must be dialed", dialed)
	}
}

// https so the cleartext gate is not what rejects this — the private address is.
// The request is rejected before any connect, so no TLS handshake happens.
func TestClientRejectsPrivateAddressForUnapprovedOrigin(t *testing.T) {
	for name, addr := range map[string]string{
		"rfc1918": "10.0.0.5",
		"ula":     "fd00::1",
		"cgnat":   "100.64.1.2",
	} {
		t.Run(name, func(t *testing.T) {
			res, rec := newHarness(t, okHandler())
			res.set("repo.lan", publicAddrs(t, addr))
			c := mustClient(t, testPolicy(res, rec))

			_, _, err := get(c, "https://repo.lan/file.bin")
			assertReason(t, err, ReasonPrivateAddressNotAllowed)
			if dialed := rec.dialed(); len(dialed) != 0 {
				t.Fatalf("policy dialed %v; nothing must be dialed", dialed)
			}
		})
	}
}

func TestClientAllowsPrivateAddressForConfiguredControlPlaneOrigin(t *testing.T) {
	res, rec := newHarness(t, okHandler())
	res.set("breeze.lan", publicAddrs(t, "10.0.0.5"))
	p := testPolicy(res, rec)
	p.ControlPlaneOrigins = []string{"http://breeze.lan:8080"}
	c := mustClient(t, p)

	status, body, err := get(c, "http://breeze.lan:8080/agent.msi")
	if err != nil {
		t.Fatalf("request to the configured private control plane failed: %v", err)
	}
	if status != http.StatusOK || body != "ok" {
		t.Fatalf("status=%d body=%q", status, body)
	}
	if want := []string{"10.0.0.5:8080"}; !equalStrings(rec.dialed(), want) {
		t.Fatalf("dialed %v, want %v", rec.dialed(), want)
	}
}

// A customer-hosted managed-software repo on a private address, over https
// (the only channel managed software ever gets). example.com is the hostname
// because that is what the test server's certificate is valid for.
func TestClientAllowsPrivateAddressForApprovedPrivateOrigin(t *testing.T) {
	res, rec, _, pool := newTLSHarness(t, okHandler())
	res.set("example.com", publicAddrs(t, "192.168.20.7"))
	p := testPolicy(res, rec)
	p.Purpose = ManagedSoftwareDownload
	p.ControlPlaneOrigins = nil
	p.ApprovedPrivateOrigins = []string{"https://example.com"}
	c := mustClient(t, p)
	baseTransport(t, c).TLSClientConfig.RootCAs = pool

	if _, _, err := get(c, "https://example.com/app.msi"); err != nil {
		t.Fatalf("request to the approved private origin failed: %v", err)
	}
	if want := []string{"192.168.20.7:443"}; !equalStrings(rec.dialed(), want) {
		t.Fatalf("dialed %v, want %v", rec.dialed(), want)
	}
}

// The allowlist is exact: a lookalike hostname under the approved suffix, a
// different port and a different scheme are all separate origins. The approved
// origin is https here so each case isolates the private-address rule; the
// scheme-mismatch case necessarily reports the cleartext rule instead, which is
// the same exactness proved one layer earlier.
func TestClientRejectsPrivateAddressForLookalikeOrigins(t *testing.T) {
	lookalikes := []struct {
		raw        string
		wantReason string
	}{
		{"https://evil.breeze.lan:8080/x", ReasonPrivateAddressNotAllowed}, // suffix lookalike
		{"https://breeze.lan.evil:8080/x", ReasonPrivateAddressNotAllowed}, // prefix lookalike
		{"https://breeze.lan:9090/x", ReasonPrivateAddressNotAllowed},      // port mismatch
		{"http://breeze.lan:8080/x", ReasonCleartextNotAllowed},            // scheme mismatch
	}
	for _, tt := range lookalikes {
		t.Run(tt.raw, func(t *testing.T) {
			res, rec := newHarness(t, okHandler())
			for _, h := range []string{"breeze.lan", "evil.breeze.lan", "breeze.lan.evil"} {
				res.set(h, publicAddrs(t, "10.0.0.5"))
			}
			p := testPolicy(res, rec)
			p.ControlPlaneOrigins = []string{"https://breeze.lan:8080"}
			c := mustClient(t, p)

			_, _, err := get(c, tt.raw)
			assertReason(t, err, tt.wantReason)
			if dialed := rec.dialed(); len(dialed) != 0 {
				t.Fatalf("policy dialed %v; nothing must be dialed", dialed)
			}
		})
	}
}

// The crux of the rebinding defense: the address that is validated is the
// address that is dialed. The resolver hands out a safe answer first and a
// loopback answer second. If anything re-resolved between validation and the
// connect — our own code, or the stdlib because we handed it a hostname — the
// first request would dial 127.0.0.1 (or "cdn.example") instead of the
// validated 203.0.113.10.
func TestDialUsesTheValidatedAddressNotAReResolution(t *testing.T) {
	res, rec := newHarness(t, okHandler())
	res.set("cdn.example",
		publicAddrs(t, "203.0.113.10"), // first lookup: safe
		publicAddrs(t, "127.0.0.1"),    // second lookup: hostile
	)
	c := mustClient(t, testPolicy(res, rec))
	// Force a fresh dial per request so the second lookup is actually consumed
	// by a second connection attempt rather than hidden by connection reuse.
	baseTransport(t, c).DisableKeepAlives = true

	if _, _, err := get(c, "http://cdn.example/file.bin"); err != nil {
		t.Fatalf("first request: %v", err)
	}
	if want := []string{"203.0.113.10:80"}; !equalStrings(rec.dialed(), want) {
		t.Fatalf("dialed %v, want %v — the dial did not use the validated address", rec.dialed(), want)
	}
	if got := res.callCount("cdn.example"); got != 1 {
		t.Fatalf("resolver called %d times for one request, want exactly 1", got)
	}

	// The second request re-resolves (a new connection) and must be rejected by
	// the same validation, proving the check is per dial and not per client.
	_, _, err := get(c, "http://cdn.example/file.bin")
	assertReason(t, err, ReasonForbiddenAddress)
	if got := len(rec.dialed()); got != 1 {
		t.Fatalf("dialed %v; the hostile second answer must not be dialed", rec.dialed())
	}
}

// ---------------------------------------------------------------------------
// redirects
// ---------------------------------------------------------------------------

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok")
	})
}

// redirectHandler serves:
//
//	/hop/N     -> 302 to /hop/N-1 on the same host, /hop/0 returns 200
//	/to?u=URL  -> 302 to URL
//	/echo-auth -> 200 with the Authorization and Cookie headers it received
func redirectHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/hop/", func(w http.ResponseWriter, r *http.Request) {
		n := 0
		_, _ = fmt.Sscanf(strings.TrimPrefix(r.URL.Path, "/hop/"), "%d", &n)
		if n <= 0 {
			_, _ = io.WriteString(w, "ok")
			return
		}
		http.Redirect(w, r, fmt.Sprintf("/hop/%d", n-1), http.StatusFound)
	})
	mux.HandleFunc("/to", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, r.URL.Query().Get("u"), http.StatusFound)
	})
	mux.HandleFunc("/echo-auth", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "auth=%q cookie=%q proxyauth=%q",
			r.Header.Get("Authorization"), r.Header.Get("Cookie"), r.Header.Get("Proxy-Authorization"))
	})
	return mux
}

func TestRedirectToUnsafeTargetRejected(t *testing.T) {
	res, rec := newHarness(t, redirectHandler())
	res.set("cdn.example", publicAddrs(t, "203.0.113.10"))
	res.set("evil.example", publicAddrs(t, "169.254.169.254"))
	c := mustClient(t, testPolicy(res, rec))

	_, _, err := get(c, "http://cdn.example/to?u=https://evil.example/hop/0")
	assertReason(t, err, ReasonForbiddenAddress)
	if want := []string{"203.0.113.10:80"}; !equalStrings(rec.dialed(), want) {
		t.Fatalf("dialed %v, want only the first hop %v", rec.dialed(), want)
	}
}

func TestRedirectToForbiddenHostnameRejected(t *testing.T) {
	res, rec := newHarness(t, redirectHandler())
	res.set("cdn.example", publicAddrs(t, "203.0.113.10"))
	c := mustClient(t, testPolicy(res, rec))

	_, _, err := get(c, "http://cdn.example/to?u=https://metadata.google.internal/computeMetadata/v1/")
	assertReason(t, err, ReasonForbiddenHostname)
}

func TestRedirectToPrivateAddressRejected(t *testing.T) {
	res, rec := newHarness(t, redirectHandler())
	res.set("cdn.example", publicAddrs(t, "203.0.113.10"))
	res.set("inside.lan", publicAddrs(t, "10.1.2.3"))
	c := mustClient(t, testPolicy(res, rec))

	_, _, err := get(c, "http://cdn.example/to?u=https://inside.lan/hop/0")
	assertReason(t, err, ReasonPrivateAddressNotAllowed)
}

func TestRedirectLimit(t *testing.T) {
	for _, tc := range []struct {
		hops    int
		wantErr bool
	}{{9, false}, {10, false}, {11, true}} {
		t.Run(fmt.Sprintf("%d hops", tc.hops), func(t *testing.T) {
			res, rec := newHarness(t, redirectHandler())
			res.set("cdn.example", publicAddrs(t, "203.0.113.10"))
			c := mustClient(t, testPolicy(res, rec))

			_, _, err := get(c, fmt.Sprintf("http://cdn.example/hop/%d", tc.hops))
			if tc.wantErr {
				assertReason(t, err, ReasonTooManyRedirects)
				return
			}
			if err != nil {
				t.Fatalf("%d hops should be followed, got %v", tc.hops, err)
			}
		})
	}
}

func TestRedirectSameOriginKeepsAuthorization(t *testing.T) {
	res, rec := newHarness(t, redirectHandler())
	res.set("cdn.example", publicAddrs(t, "203.0.113.10"))
	c := mustClient(t, testPolicy(res, rec))

	req, err := http.NewRequest(http.MethodGet, "http://cdn.example/to?u=/echo-auth", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer tok")
	req.Header.Set("Cookie", "sid=1")
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if want := `auth="Bearer tok" cookie="sid=1" proxyauth=""`; string(body) != want {
		t.Fatalf("body = %s, want %s", body, want)
	}
}

// Go's own redirect handling keeps credentials across a subdomain change and
// across a port change. Our rule is exact-origin, so both must be stripped.
func TestRedirectCrossOriginStripsCredentials(t *testing.T) {
	targets := []string{
		"http://sub.cdn.example/echo-auth",  // subdomain: Go alone would keep it
		"http://cdn.example:8080/echo-auth", // port change: Go alone would keep it
		"http://other.example/echo-auth",    // unrelated host
	}
	for _, target := range targets {
		t.Run(target, func(t *testing.T) {
			res, rec := newHarness(t, redirectHandler())
			for _, h := range []string{"cdn.example", "sub.cdn.example", "other.example"} {
				res.set(h, publicAddrs(t, "203.0.113.10"))
			}
			c := mustClient(t, testPolicy(res, rec))

			req, err := http.NewRequest(http.MethodGet, "http://cdn.example/to?u="+target, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer tok")
			req.Header.Set("Proxy-Authorization", "Basic cHJveHk=")
			req.Header.Set("Cookie", "sid=1")
			resp, err := c.Do(req)
			if err != nil {
				t.Fatalf("Do: %v", err)
			}
			defer func() { _ = resp.Body.Close() }()
			body, _ := io.ReadAll(resp.Body)
			if want := `auth="" cookie="" proxyauth=""`; string(body) != want {
				t.Fatalf("body = %s, want %s (credentials leaked across origins)", body, want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// TLS: downgrade, SNI
// ---------------------------------------------------------------------------

type sniRecorder struct {
	mu    sync.Mutex
	names []string
}

func (s *sniRecorder) record(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.names = append(s.names, name)
}

func (s *sniRecorder) seen() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.names...)
}

// newTLSHarness starts an HTTPS test server. Its certificate is valid for
// "example.com", which is therefore the hostname every TLS test requests.
func newTLSHarness(t *testing.T, h http.Handler) (*stubResolver, *dialRecorder, *sniRecorder, *x509.CertPool) {
	t.Helper()
	sni := &sniRecorder{}
	srv := httptest.NewUnstartedServer(h)
	srv.TLS = &tls.Config{
		GetConfigForClient: func(chi *tls.ClientHelloInfo) (*tls.Config, error) {
			sni.record(chi.ServerName)
			return nil, nil
		},
	}
	srv.StartTLS()
	t.Cleanup(srv.Close)

	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	return newStubResolver(), &dialRecorder{to: srv.Listener.Addr().String()}, sni, pool
}

// The dial connects to a validated IP, but the TLS handshake must still assert
// the original hostname — otherwise certificate validation is meaningless.
func TestTLSServerNameIsTheRequestHostname(t *testing.T) {
	res, rec, sni, pool := newTLSHarness(t, okHandler())
	res.set("example.com", publicAddrs(t, "203.0.113.10"))
	p := testPolicy(res, rec)
	p.Purpose = ManagedSoftwareDownload
	c := mustClient(t, p)
	baseTransport(t, c).TLSClientConfig.RootCAs = pool

	if _, _, err := get(c, "https://example.com/app.msi"); err != nil {
		t.Fatalf("https request: %v", err)
	}
	if want := []string{"203.0.113.10:443"}; !equalStrings(rec.dialed(), want) {
		t.Fatalf("dialed %v, want %v", rec.dialed(), want)
	}
	if names := sni.seen(); !equalStrings(names, []string{"example.com"}) {
		t.Fatalf("SNI = %v, want [example.com]", names)
	}
}

func TestRedirectHTTPSToHTTPRejected(t *testing.T) {
	res, rec, _, pool := newTLSHarness(t, redirectHandler())
	res.set("example.com", publicAddrs(t, "203.0.113.10"))
	// http://example.com is a configured cleartext origin here, so the cleartext
	// gate passes it: a rejection can only come from the downgrade rule. Being
	// configured for cleartext never excuses downgrading an https exchange.
	c := mustClient(t, testPolicy(res, rec))
	baseTransport(t, c).TLSClientConfig.RootCAs = pool

	_, _, err := get(c, "https://example.com/to?u=http://example.com/hop/0")
	assertReason(t, err, ReasonSchemeDowngrade)
}

// ---------------------------------------------------------------------------
// proxy, timeout, byte bound
// ---------------------------------------------------------------------------

func TestEnvironmentProxyIsIgnored(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:9/")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:9/")
	t.Setenv("http_proxy", "http://127.0.0.1:9/")
	t.Setenv("ALL_PROXY", "socks5://127.0.0.1:9")
	t.Setenv("NO_PROXY", "")

	res, rec := newHarness(t, okHandler())
	res.set("cdn.example", publicAddrs(t, "203.0.113.10"))
	c := mustClient(t, testPolicy(res, rec))

	if tr := baseTransport(t, c); tr.Proxy != nil {
		t.Fatal("Transport.Proxy must be nil so environment proxies cannot intercept")
	}
	if _, _, err := get(c, "http://cdn.example/file.bin"); err != nil {
		t.Fatalf("request: %v", err)
	}
	if want := []string{"203.0.113.10:80"}; !equalStrings(rec.dialed(), want) {
		t.Fatalf("dialed %v, want %v — a proxy was consulted", rec.dialed(), want)
	}
}

func TestCloseIdleConnectionsReachesTheTransport(t *testing.T) {
	res, rec := newHarness(t, okHandler())
	res.set("cdn.example", publicAddrs(t, "203.0.113.10"))
	c := mustClient(t, testPolicy(res, rec))

	if _, _, err := get(c, "http://cdn.example/a"); err != nil {
		t.Fatalf("first request: %v", err)
	}
	c.CloseIdleConnections()
	if _, _, err := get(c, "http://cdn.example/b"); err != nil {
		t.Fatalf("second request: %v", err)
	}
	if got := len(rec.dialed()); got != 2 {
		t.Fatalf("dialed %d times, want 2 — CloseIdleConnections did not reach the transport", got)
	}
}

func TestRequestTimeout(t *testing.T) {
	res, rec := newHarness(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}))
	res.set("cdn.example", publicAddrs(t, "203.0.113.10"))
	p := testPolicy(res, rec)
	p.RequestTimeout = 100 * time.Millisecond
	c := mustClient(t, p)

	start := time.Now()
	if _, _, err := get(c, "http://cdn.example/slow"); err == nil {
		t.Fatal("expected a timeout error")
	}
	elapsed := time.Since(start)
	// Lower bound: the request must actually have waited for the deadline. A
	// policy rejection would return instantly and pass a one-sided assertion.
	if elapsed < 100*time.Millisecond {
		t.Fatalf("request failed after %v, before the 100ms deadline — it did not time out", elapsed)
	}
	// Upper bound: 5x the configured timeout. Loose enough for a loaded CI
	// runner, tight enough to catch a timeout set to the wrong value.
	if elapsed > 500*time.Millisecond {
		t.Fatalf("request took %v; the 100ms policy timeout was not enforced", elapsed)
	}
}

func TestResponseByteBound(t *testing.T) {
	body := bytes.Repeat([]byte("A"), 4096)
	res, rec := newHarness(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	}))
	res.set("cdn.example", publicAddrs(t, "203.0.113.10"))

	t.Run("over the bound", func(t *testing.T) {
		p := testPolicy(res, rec)
		p.MaxResponseBytes = 1024
		c := mustClient(t, p)
		_, _, err := get(c, "http://cdn.example/file.bin")
		assertReason(t, err, ReasonResponseTooLarge)
	})

	t.Run("within the bound", func(t *testing.T) {
		p := testPolicy(res, rec)
		p.MaxResponseBytes = 1 << 20
		c := mustClient(t, p)
		_, got, err := get(c, "http://cdn.example/file.bin")
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if len(got) != len(body) {
			t.Fatalf("read %d bytes, want %d", len(got), len(body))
		}
	})
}

func TestCopyBounded(t *testing.T) {
	t.Run("under the bound", func(t *testing.T) {
		var dst bytes.Buffer
		n, err := CopyBounded(&dst, strings.NewReader("hello"), 10)
		if err != nil || n != 5 || dst.String() != "hello" {
			t.Fatalf("n=%d err=%v dst=%q", n, err, dst.String())
		}
	})

	t.Run("exactly at the bound", func(t *testing.T) {
		var dst bytes.Buffer
		n, err := CopyBounded(&dst, strings.NewReader("hello"), 5)
		if err != nil || n != 5 || dst.String() != "hello" {
			t.Fatalf("n=%d err=%v dst=%q", n, err, dst.String())
		}
	})

	t.Run("over the bound errors and does not truncate silently", func(t *testing.T) {
		var dst bytes.Buffer
		n, err := CopyBounded(&dst, strings.NewReader("hello world"), 5)
		assertReason(t, err, ReasonResponseTooLarge)
		if !errors.Is(err, ErrResponseTooLarge) {
			t.Fatalf("err = %v, want ErrResponseTooLarge", err)
		}
		if n > 5 {
			t.Fatalf("wrote %d bytes past the bound of 5", n)
		}
		if dst.Len() > 5 {
			t.Fatalf("dst holds %d bytes, more than the bound", dst.Len())
		}
	})

	t.Run("zero bound rejects any content", func(t *testing.T) {
		var dst bytes.Buffer
		if _, err := CopyBounded(&dst, strings.NewReader("x"), 0); err == nil {
			t.Fatal("expected an error for a zero bound with content")
		}
	})

	t.Run("negative bound is invalid", func(t *testing.T) {
		var dst bytes.Buffer
		_, err := CopyBounded(&dst, strings.NewReader("x"), -1)
		assertReason(t, err, ReasonInvalidBound)
	})

	t.Run("source error propagates", func(t *testing.T) {
		var dst bytes.Buffer
		want := errors.New("boom")
		_, err := CopyBounded(&dst, io.MultiReader(strings.NewReader("ab"), errReader{want}), 100)
		if !errors.Is(err, want) {
			t.Fatalf("err = %v, want %v", err, want)
		}
	})
}

type errReader struct{ err error }

func (r errReader) Read([]byte) (int, error) { return 0, r.err }

// ---------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------

func TestConcurrentRequestsShareOneClient(t *testing.T) {
	res, rec := newHarness(t, okHandler())
	res.set("cdn.example", publicAddrs(t, "203.0.113.10"))
	res.set("evil.example", publicAddrs(t, "127.0.0.1"))
	c := mustClient(t, testPolicy(res, rec))

	var wg sync.WaitGroup
	errCh := make(chan error, 40)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := get(c, "http://cdn.example/file.bin"); err != nil {
				errCh <- err
			}
		}()
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := get(c, "http://evil.example/file.bin"); err == nil {
				errCh <- errors.New("loopback answer was accepted")
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatalf("concurrent request: %v", err)
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// cleartextTestOrigins are the public test hosts, listed as configured
// control-plane origins because that is the ONLY way plain HTTP is permitted.
// Every one of them resolves to a public address in tests, so the private-
// address reachability that also comes with a control-plane origin is never
// what a test is leaning on.
var cleartextTestOrigins = []string{
	"http://cdn.example",
	"http://cdn.example:8080",
	"http://sub.cdn.example",
	"http://other.example",
	"http://evil.example",
	"http://example.com",
}

func testPolicy(res *stubResolver, rec *dialRecorder) Policy {
	return Policy{
		Purpose:             ControlPlaneDownload,
		ControlPlaneOrigins: cleartextTestOrigins,
		RequestTimeout:      10 * time.Second,
		Resolver:            res,
		rawDial:             rec.dial,
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
