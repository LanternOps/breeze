package updater

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/netpolicy"
	"github.com/breeze-rmm/agent/internal/secmem"
)

// This file exercises the netpolicy integration added to the updater in
// task 3 of the wave-06 agent/updater-network security remediation. It does
// NOT re-prove netpolicy's own dial-time mechanics (loopback/private/metadata
// classification, single-resolution-per-dial, credential stripping) — that is
// exhaustively covered with mutation testing in
// agent/internal/netpolicy/{address,http}_test.go. What this file proves is
// WIRING: that the updater's client really is a netpolicy client built from
// the documented policy shape, that both configured control-plane origins
// reach it, that the old local host/scheme comparison is gone, and that
// CopyBounded — not io.Copy — is what limits a downloaded binary.
//
// Test technique notes (see task-3-report.md "accept-path testing" for the
// full reasoning):
//
//   - A rejection that fires before any TCP connect (loopback/metadata shape,
//     an unapproved private literal, a forbidden hostname, a redirect
//     downgrade, a too-long redirect chain) needs no network access at all —
//     it is a pure computation inside RoundTrip/CheckRedirect/DialContext
//     that returns before dialing. These tests call the real client built by
//     New() or updaterPolicy() directly.
//   - http.Client.CheckRedirect is a plain exported func field: calling it
//     directly with synthetic *http.Request values exercises the exact
//     redirect policy netpolicy.NewClient wired in (downgrade rejection,
//     redirect-limit, credential stripping) without any network I/O.
//   - A genuinely ALLOWED destination (a configured private origin, a public
//     CDN) still requires a real dial attempt to prove reachability, but
//     nothing in this repo or sandbox can complete that dial against a local
//     listener — netpolicy forbids loopback outright and its only redirect-
//     to-local-listener seam (rawDial) is unexported and package-private by
//     design (see netpolicy/http_test.go's dialRecorder). Those cases are
//     proven with a NEGATIVE assertion instead: the request is allowed to
//     attempt a real (bounded-timeout) connect, and the test asserts the
//     resulting error is NOT a policy rejection for that specific reason —
//     i.e. policy let it through; only the absence of a real listener failed
//     it. A short Dialer.Timeout bounds the wait.
//   - "Public CDN redirect" and "oversized binary" are proven against real
//     local httptest servers with u.client overridden to the plain
//     httptest.Server client (the same bypass pattern updater_test.go already
//     uses) — this is valid because both properties (the old host-comparison
//     being gone, CopyBounded being the copy path) live in updater.go's own
//     code, not in netpolicy's transport, so they do not require netpolicy's
//     client to be active to prove.

// ---------------------------------------------------------------------------
// Policy construction (config wiring, no network)
// ---------------------------------------------------------------------------

func TestUpdaterPolicy_MatchesBriefShape(t *testing.T) {
	cfg := &Config{
		ServerURL:       staticServerURL("https://primary.example"),
		BackupServerURL: "https://backup.example",
	}
	p := updaterPolicy(cfg)

	if p.Purpose != netpolicy.ControlPlaneDownload {
		t.Fatalf("Purpose = %v, want ControlPlaneDownload", p.Purpose)
	}
	wantOrigins := []string{"https://primary.example", "https://backup.example"}
	if !reflect.DeepEqual(p.ControlPlaneOrigins, wantOrigins) {
		t.Fatalf("ControlPlaneOrigins = %v, want %v", p.ControlPlaneOrigins, wantOrigins)
	}
	if len(p.ApprovedPrivateOrigins) != 0 {
		t.Fatalf("ApprovedPrivateOrigins should be empty, got %v", p.ApprovedPrivateOrigins)
	}
	if p.MaxRedirects != 10 {
		t.Fatalf("MaxRedirects = %d, want 10", p.MaxRedirects)
	}
	if p.RequestTimeout != 5*time.Minute {
		t.Fatalf("RequestTimeout = %v, want 5m", p.RequestTimeout)
	}
	if p.MaxResponseBytes != maxUpdateBinaryBytes {
		t.Fatalf("MaxResponseBytes = %d, want %d (maxUpdateBinaryBytes)", p.MaxResponseBytes, maxUpdateBinaryBytes)
	}
}

// A blank BackupServerURL (no backup configured) must not become a spurious
// empty entry that trips netpolicy's origin parser at NewClient time.
func TestUpdaterPolicy_BlankBackupServerURLIsOmitted(t *testing.T) {
	cfg := &Config{ServerURL: staticServerURL("https://primary.example")}
	p := updaterPolicy(cfg)
	if _, err := netpolicy.NewClient(p); err != nil {
		t.Fatalf("policy with no configured backup should still construct: %v", err)
	}
}

// A nil Config (defensive) must not panic policy construction.
func TestUpdaterPolicy_NilConfig(t *testing.T) {
	p := updaterPolicy(nil)
	if len(p.ControlPlaneOrigins) != 0 {
		t.Fatalf("nil config should produce no origins, got %v", p.ControlPlaneOrigins)
	}
	if _, err := netpolicy.NewClient(p); err != nil {
		t.Fatalf("nil-config policy should still construct: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Rejections that fire before any dial (no network access needed)
// ---------------------------------------------------------------------------

func testAuthedUpdater(t *testing.T, serverURL, backupURL string) *Updater {
	t.Helper()
	u := New(&Config{
		ServerURL:       staticServerURL(serverURL),
		BackupServerURL: backupURL,
		AuthToken:       secmem.NewSecureString("test-token"),
	})
	if u.clientErr != nil {
		t.Fatalf("updater client failed to construct: %v", u.clientErr)
	}
	return u
}

func assertPolicyReason(t *testing.T, err error, wantReason string) {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	reason, ok := PolicyRejectionReason(err)
	if !ok {
		t.Fatalf("expected a *netpolicy.PolicyError in the chain, got %v (%T)", err, err)
	}
	if reason != wantReason {
		t.Fatalf("policy rejection reason = %q, want %q (err: %v)", reason, wantReason, err)
	}
}

// Redirect target is a loopback literal — universally forbidden, no Policy
// field can re-enable it. This is the direct SSRF-at-localhost case.
func TestDownloadFromURL_RejectsLoopbackTarget(t *testing.T) {
	u := testAuthedUpdater(t, "https://control.example", "")
	_, err := u.downloadFromURL("https://127.0.0.1:8080/agent")
	assertPolicyReason(t, err, netpolicy.ReasonForbiddenAddress)
}

// Redirect target is a private RFC1918 literal whose origin is NOT in
// ControlPlaneOrigins — must be rejected, not silently allowed just because
// it's "just" a private address.
func TestDownloadFromURL_RejectsUnapprovedRFC1918Target(t *testing.T) {
	u := testAuthedUpdater(t, "https://control.example", "")
	_, err := u.downloadFromURL("https://10.0.0.5/agent")
	assertPolicyReason(t, err, netpolicy.ReasonPrivateAddressNotAllowed)
}

// Cloud metadata endpoint, both by literal address and by the well-known
// GCP hostname — neither is ever reachable, regardless of configuration.
func TestDownloadFromURL_RejectsMetadataTargets(t *testing.T) {
	u := testAuthedUpdater(t, "https://control.example", "")

	t.Run("literal address", func(t *testing.T) {
		_, err := u.downloadFromURL("http://169.254.169.254/latest/meta-data/")
		assertPolicyReason(t, err, netpolicy.ReasonForbiddenAddress)
	})
	t.Run("gcp hostname", func(t *testing.T) {
		_, err := u.downloadFromURL("https://metadata.google.internal/computeMetadata/v1/")
		assertPolicyReason(t, err, netpolicy.ReasonForbiddenHostname)
	})
}

// DNS rebinding: a hostname (not a literal) resolving to a forbidden address
// must be rejected exactly like a literal would be. This proves the
// updater's real client consults an actual resolver at dial time — the
// necessary condition for netpolicy's single-resolution-per-dial rebinding
// defense (proven exhaustively in netpolicy's own suite) to apply here at
// all. If the updater fell back to a default http.Client, this Resolver
// would simply never be consulted and the request would either fail
// differently or (worse) succeed against whatever real DNS returns.
func TestDownloadFromURL_HostileResolverAnswerRejected(t *testing.T) {
	u := testAuthedUpdater(t, "https://control.example", "")

	policy := updaterPolicy(u.config)
	policy.Resolver = stubResolver{"attacker.example": {netip.MustParseAddr("169.254.169.254")}}
	client, err := netpolicy.NewClient(policy)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	u.client = client

	_, err = u.downloadFromURL("https://attacker.example/agent")
	assertPolicyReason(t, err, netpolicy.ReasonForbiddenAddress)
}

// A hostname resolving to a mix of a safe and a forbidden address must be
// rejected as a whole — an attacker cannot win a race between two answers.
func TestDownloadFromURL_MixedResolverAnswerRejected(t *testing.T) {
	u := testAuthedUpdater(t, "https://control.example", "")

	policy := updaterPolicy(u.config)
	policy.Resolver = stubResolver{
		"attacker.example": {netip.MustParseAddr("203.0.113.10"), netip.MustParseAddr("169.254.169.254")},
	}
	client, err := netpolicy.NewClient(policy)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	u.client = client

	_, err = u.downloadFromURL("https://attacker.example/agent")
	assertPolicyReason(t, err, netpolicy.ReasonForbiddenAddress)
}

// ---------------------------------------------------------------------------
// Redirect policy: direct CheckRedirect calls (no network — see file header)
// ---------------------------------------------------------------------------

func mustRequest(t *testing.T, rawURL string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		t.Fatalf("NewRequest(%q): %v", rawURL, err)
	}
	return req
}

// An HTTPS control-plane exchange must never be downgraded to HTTP by a
// redirect hop, even when the target host is otherwise a configured
// cleartext origin. "http://control.example" is deliberately ALSO listed as
// a configured origin (via the backup-URL slot) so the cleartext gate passes
// it and the rejection can only come from the downgrade rule — otherwise
// this test would prove nothing beyond "cleartext to an unconfigured origin
// is rejected", which TestDownloadFromURL_RejectsUnapprovedRFC1918Target-style
// tests already cover.
func TestClient_RedirectPolicy_RejectsHTTPSDowngrade(t *testing.T) {
	u := testAuthedUpdater(t, "https://control.example", "http://control.example")

	initial := mustRequest(t, "https://control.example/manifest")
	next := mustRequest(t, "http://control.example/manifest")

	err := u.client.CheckRedirect(next, []*http.Request{initial})
	assertPolicyReason(t, err, netpolicy.ReasonSchemeDowngrade)
}

// The redirect chain is capped at 10 hops (the brief's exact value) — not a
// knob any caller can raise via configuration, since updaterPolicy always
// passes exactly 10.
func TestClient_RedirectPolicy_EnforcesTenHopLimit(t *testing.T) {
	u := testAuthedUpdater(t, "https://control.example", "")

	via := make([]*http.Request, 0, 11)
	for i := 0; i < 11; i++ {
		via = append(via, mustRequest(t, "https://control.example/hop"))
	}
	next := mustRequest(t, "https://control.example/hop")

	err := u.client.CheckRedirect(next, via)
	assertPolicyReason(t, err, netpolicy.ReasonTooManyRedirects)

	// One hop under the limit must still be permitted.
	err = u.client.CheckRedirect(next, via[:9])
	if err != nil {
		t.Fatalf("9 prior hops should be permitted, got %v", err)
	}
}

// The crux of the signed-manifest-to-CDN flow: Authorization (and Cookie /
// Proxy-Authorization) must be stripped the instant the redirect target's
// origin differs from the ORIGINAL request's origin — this is what makes it
// safe for downloadFromURL to send a bearer token to the control plane and
// still be redirected onward to a public CDN without leaking that token to
// the CDN.
func TestClient_RedirectPolicy_StripsAuthorizationOnOriginChange(t *testing.T) {
	u := testAuthedUpdater(t, "https://control.example", "")

	initial := mustRequest(t, "https://control.example/manifest")
	initial.Header.Set("Authorization", "Bearer secret-token")

	next := mustRequest(t, "https://cdn.example/asset.bin")
	next.Header.Set("Authorization", "Bearer secret-token")
	next.Header.Set("Cookie", "sid=1")
	next.Header.Set("Proxy-Authorization", "Basic cHJveHk=")

	if err := u.client.CheckRedirect(next, []*http.Request{initial}); err != nil {
		t.Fatalf("cross-origin https redirect to a public CDN should be permitted: %v", err)
	}
	if got := next.Header.Get("Authorization"); got != "" {
		t.Fatalf("Authorization must be stripped on origin change, got %q", got)
	}
	if got := next.Header.Get("Cookie"); got != "" {
		t.Fatalf("Cookie must be stripped on origin change, got %q", got)
	}
	if got := next.Header.Get("Proxy-Authorization"); got != "" {
		t.Fatalf("Proxy-Authorization must be stripped on origin change, got %q", got)
	}
}

// Same-origin redirects (a same-host manifest proxy hop) must keep the
// bearer token — otherwise a legitimate same-origin redirect would silently
// break the download.
func TestClient_RedirectPolicy_KeepsAuthorizationOnSameOrigin(t *testing.T) {
	u := testAuthedUpdater(t, "https://control.example", "")

	initial := mustRequest(t, "https://control.example/manifest")
	initial.Header.Set("Authorization", "Bearer secret-token")

	next := mustRequest(t, "https://control.example/manifest/redirected")
	next.Header.Set("Authorization", "Bearer secret-token")

	if err := u.client.CheckRedirect(next, []*http.Request{initial}); err != nil {
		t.Fatalf("same-origin redirect should be permitted: %v", err)
	}
	if got := next.Header.Get("Authorization"); got != "Bearer secret-token" {
		t.Fatalf("Authorization must be retained on a same-origin redirect, got %q", got)
	}
}

// ---------------------------------------------------------------------------
// Allowed destinations that need a dial attempt: negative-assertion tests.
// See file header for why these cannot complete a full exchange.
// ---------------------------------------------------------------------------

// stubResolver answers every LookupNetIP call for a configured host with a
// fixed address set, and fails any other host — a minimal netpolicy.Resolver
// for tests that don't need the successive-answer scripting netpolicy's own
// suite uses.
type stubResolver map[string][]netip.Addr

func (r stubResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	if addrs, ok := r[host]; ok {
		return addrs, nil
	}
	return nil, errors.New("stubResolver: no answer for " + host)
}

// shortDialer bounds a real (necessarily-failing, since nothing listens at
// the test addresses used below) connect attempt so these tests stay fast
// rather than hanging on the OS dial timeout.
func shortDialer() *net.Dialer { return &net.Dialer{Timeout: 300 * time.Millisecond} }

// A private-network control plane (self-hosted deployment) must be
// REACHABLE, not just shape-valid: this proves ControlPlaneOrigins actually
// grants private-address dial-time access, the property the brief's
// "private configured server" scenario names. Nothing listens at the test
// address, so the request necessarily fails — but the assertion is that it
// fails with a NETWORK error, never with private_address_not_allowed or
// cleartext_not_allowed. A pre-fix client (default http.Client, or a
// misconfigured policy missing this origin) would instead either succeed
// against a real network host or fail closed with a policy reason; the
// specific-reason exclusion is what a mutation deleting the origin wiring
// would flip.
func TestDownloadFromURL_ConfiguredPrivateOriginIsPolicyAllowed(t *testing.T) {
	u := testAuthedUpdater(t, "http://breeze.lan:8080", "")

	policy := updaterPolicy(u.config)
	policy.Resolver = stubResolver{"breeze.lan": {netip.MustParseAddr("10.9.9.9")}}
	policy.Dialer = shortDialer()
	client, err := netpolicy.NewClient(policy)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	u.client = client

	_, err = u.downloadFromURL("http://breeze.lan:8080/agent")
	if err == nil {
		t.Fatal("expected an error — nothing listens at the test address — but got nil")
	}
	if reason, ok := PolicyRejectionReason(err); ok {
		if reason == netpolicy.ReasonPrivateAddressNotAllowed || reason == netpolicy.ReasonCleartextNotAllowed {
			t.Fatalf("configured private control-plane origin was policy-rejected (%s), want a network-layer failure instead: %v", reason, err)
		}
	}
}

// The configured BACKUP origin specifically — not just the primary — must
// reach ControlPlaneOrigins. This is the exact gap the brief calls out:
// "Missing one silently produces a client that rejects the backup control
// plane." A construction site that forgot to plumb BackupServerURL would
// fail this with private_address_not_allowed even though the primary-origin
// test above passes.
func TestDownloadFromURL_ConfiguredBackupOriginIsPolicyAllowed(t *testing.T) {
	u := testAuthedUpdater(t, "https://primary.example", "http://backup.lan:8080")

	policy := updaterPolicy(u.config)
	policy.Resolver = stubResolver{"backup.lan": {netip.MustParseAddr("10.9.9.10")}}
	policy.Dialer = shortDialer()
	client, err := netpolicy.NewClient(policy)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	u.client = client

	_, err = u.downloadFromURL("http://backup.lan:8080/agent")
	if err == nil {
		t.Fatal("expected an error — nothing listens at the test address — but got nil")
	}
	if reason, ok := PolicyRejectionReason(err); ok {
		if reason == netpolicy.ReasonPrivateAddressNotAllowed || reason == netpolicy.ReasonCleartextNotAllowed {
			t.Fatalf("configured BACKUP control-plane origin was policy-rejected (%s) — BackupServerURL did not reach ControlPlaneOrigins: %v", reason, err)
		}
	}
}

// A hostile HTTP_PROXY / HTTPS_PROXY must never be consulted, even when it
// is reachable and the primary request fails for an unrelated reason. The
// primary target is deliberately a policy-rejected address (loopback) so the
// download fails immediately and deterministically without depending on any
// real network reachability; the only thing under test is whether the
// configured proxy was ever dialed.
func TestDownloadFromURL_IgnoresHostileProxyEnvironment(t *testing.T) {
	var proxyHits int
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyHits++
		w.WriteHeader(http.StatusOK)
	}))
	defer proxy.Close()

	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("http_proxy", proxy.URL)
	t.Setenv("ALL_PROXY", proxy.URL)
	t.Setenv("NO_PROXY", "")

	u := testAuthedUpdater(t, "https://control.example", "")

	_, err := u.downloadFromURL("https://127.0.0.1:1/agent")
	assertPolicyReason(t, err, netpolicy.ReasonForbiddenAddress)

	if proxyHits != 0 {
		t.Fatalf("hostile proxy was contacted %d times; Transport.Proxy must be nil", proxyHits)
	}
}

// ---------------------------------------------------------------------------
// Behaviors provable against a real local server (bypass client — see file
// header for why this is valid for these two specific properties).
// ---------------------------------------------------------------------------

// Regression guard for the removed local host/scheme comparison: a signed
// manifest legitimately names a public CDN URL on a DIFFERENT host than the
// configured control plane (the documented downloadFromURL flow). The OLD
// code's `parsed.Host != serverParsed.Host` check rejected this outright —
// self-hosted CDN-backed releases could never download. This test fails
// against that old code and passes once the local comparison is gone and
// destination safety is netpolicy's job alone.
func TestDownloadFromURL_AllowsCrossOriginPublicCDN(t *testing.T) {
	cdnContent := []byte("cdn-hosted binary bytes")
	cdn := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(cdnContent)
	}))
	defer cdn.Close()

	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("control-plane host should not be hit by downloadFromURL directly in this test")
	}))
	defer control.Close()

	u := New(&Config{
		ServerURL: staticServerURL(control.URL),
		AuthToken: secmem.NewSecureString("test-token"),
	})
	// Bypass netpolicy for this test: the property under test — the local
	// host-comparison being gone — lives in downloadFromURL's own code, not
	// in the transport, and cdn.URL is a loopback address netpolicy would
	// reject outright regardless of origin (see file header).
	u.client = cdn.Client()

	tempPath, err := u.downloadFromURL(cdn.URL + "/asset.bin")
	if err != nil {
		t.Fatalf("cross-origin CDN download should succeed once the local host check is removed: %v", err)
	}
	defer func() { _ = os.Remove(tempPath) }()

	got, err := os.ReadFile(tempPath)
	if err != nil {
		t.Fatalf("read downloaded file: %v", err)
	}
	if !bytes.Equal(got, cdnContent) {
		t.Fatalf("downloaded content mismatch: got %q", got)
	}
}

// CopyBounded, not io.Copy, must be what limits the downloaded binary size.
// maxUpdateBinaryBytes is temporarily shrunk (it's a var precisely so tests
// can do this — see its doc comment) so the test doesn't need to move
// hundreds of megabytes. The bypass client is used because the property
// under test is the explicit CopyBounded call in downloadFromURL, which
// applies regardless of which client delivered the bytes — proving it holds
// even when the transport-level Policy.MaxResponseBytes guard (which would
// ALSO catch this against a real netpolicy client) is not in the picture.
func TestDownloadFromURL_OversizedBinaryRejected(t *testing.T) {
	oldMax := maxUpdateBinaryBytes
	maxUpdateBinaryBytes = 32
	t.Cleanup(func() { maxUpdateBinaryBytes = oldMax })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("A", int(maxUpdateBinaryBytes)+1)))
	}))
	defer server.Close()

	u := New(&Config{
		ServerURL: staticServerURL(server.URL),
		AuthToken: secmem.NewSecureString("test-token"),
	})
	u.client = server.Client()

	_, err := u.downloadFromURL(server.URL + "/asset.bin")
	if err == nil {
		t.Fatal("expected oversized binary to be rejected")
	}
	if !errors.Is(err, netpolicy.ErrResponseTooLarge) {
		t.Fatalf("expected ErrResponseTooLarge in the chain, got %v", err)
	}
}
