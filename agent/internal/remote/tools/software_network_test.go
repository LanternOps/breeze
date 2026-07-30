package tools

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/netpolicy"
)

// This file exercises the netpolicy integration added to managed software
// installs in task 5 of the wave-06 agent/updater-network security
// remediation. It does NOT re-prove netpolicy's own dial-time mechanics
// (address classification, single-resolution-per-dial, credential stripping) —
// that lives in agent/internal/netpolicy/{address,http}_test.go. What this
// proves is WIRING: that a managed software download really runs on a
// netpolicy client built from the documented policy shape, that the
// server-supplied downloadPolicy is parsed strictly, that the old local
// scheme/host checks are gone, and that CopyBounded is what limits the file.
//
// Test technique (same reasoning as updater_security_test.go's header):
//
//   - Rejections that fire before any TCP connect (a forbidden literal, a
//     forbidden hostname, an unapproved private literal, a redirect downgrade,
//     an over-long redirect chain) are pure computation and need no network.
//   - http.Client.CheckRedirect is a plain exported func field, so calling it
//     with synthetic requests exercises exactly the redirect policy
//     netpolicy.NewClient wired in.
//   - A genuinely ALLOWED destination cannot complete against a local listener
//     (netpolicy forbids loopback outright, and its rawDial seam is
//     package-private), so those cases use a NEGATIVE assertion: the request
//     is allowed to attempt a real, short-timeout connect and the test asserts
//     the failure is NOT the specific policy rejection under test.
//   - Overflow is proven against a real httptest server with an explicit
//     bypass client, because CopyBounded lives in downloadFile's own code.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type swStubResolver map[string][]netip.Addr

func (r swStubResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	if addrs, ok := r[host]; ok {
		return addrs, nil
	}
	return nil, errors.New("swStubResolver: no answer for " + host)
}

func swShortDialer() *net.Dialer { return &net.Dialer{Timeout: 300 * time.Millisecond} }

func swMustRequest(t *testing.T, rawURL string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		t.Fatalf("NewRequest(%q): %v", rawURL, err)
	}
	return req
}

func swPolicyReason(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	var pe *netpolicy.PolicyError
	if !errors.As(err, &pe) {
		t.Fatalf("expected a *netpolicy.PolicyError in the chain, got %v (%T)", err, err)
	}
	if pe.Reason != want {
		t.Fatalf("policy reason = %q, want %q (err: %v)", pe.Reason, want, err)
	}
}

// installPayload builds a minimal, otherwise-valid software_install payload.
func installPayload(downloadURL string, policy any) map[string]any {
	p := map[string]any{
		"downloadUrl":  downloadURL,
		"fileName":     "pkg.exe",
		"fileType":     "exe",
		"softwareName": "Acme",
		"version":      "1.0.0",
	}
	if policy != nil {
		p["downloadPolicy"] = policy
	}
	return p
}

func swClient(t *testing.T, origins []string, mutate func(*netpolicy.Policy)) *http.Client {
	t.Helper()
	policy := managedSoftwarePolicy(origins)
	if mutate != nil {
		mutate(&policy)
	}
	client, err := netpolicy.NewClient(policy)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return client
}

func swTempFile(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "pkg.exe")
}

// ---------------------------------------------------------------------------
// Policy construction
// ---------------------------------------------------------------------------

func TestManagedSoftwarePolicy_MatchesBriefShape(t *testing.T) {
	t.Parallel()

	p := managedSoftwarePolicy([]string{"https://files.corp.internal"})

	if p.Purpose != netpolicy.ManagedSoftwareDownload {
		t.Fatalf("Purpose = %v, want ManagedSoftwareDownload", p.Purpose)
	}
	if len(p.ControlPlaneOrigins) != 0 {
		t.Fatalf("managed software must never inherit control-plane origins, got %v", p.ControlPlaneOrigins)
	}
	if !reflect.DeepEqual(p.ApprovedPrivateOrigins, []string{"https://files.corp.internal"}) {
		t.Fatalf("ApprovedPrivateOrigins = %v", p.ApprovedPrivateOrigins)
	}
	if p.MaxRedirects != 10 {
		t.Fatalf("MaxRedirects = %d, want 10", p.MaxRedirects)
	}
	if p.RequestTimeout != 15*time.Minute {
		t.Fatalf("RequestTimeout = %v, want 15m", p.RequestTimeout)
	}
	if p.MaxResponseBytes != maxInstallFileSize {
		t.Fatalf("MaxResponseBytes = %d, want %d", p.MaxResponseBytes, maxInstallFileSize)
	}
}

func TestManagedSoftwareClient_CarriesTheTimeout(t *testing.T) {
	t.Parallel()

	client := swClient(t, nil, nil)
	if client.Timeout != 15*time.Minute {
		t.Fatalf("client.Timeout = %v, want 15m", client.Timeout)
	}
}

// ---------------------------------------------------------------------------
// Strict downloadPolicy parsing
//
// Missing/malformed policy must yield NO approved origins: a public
// destination still works, every private answer fails closed at dial time.
// ---------------------------------------------------------------------------

func TestParseDownloadPolicy_Strict(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		payload map[string]any
		want    []string
	}{
		{
			name:    "absent policy yields no approved origins",
			payload: map[string]any{},
			want:    nil,
		},
		{
			name: "well formed policy",
			payload: map[string]any{"downloadPolicy": map[string]any{
				"version":                float64(1),
				"approvedPrivateOrigins": []any{"https://files.corp.internal", "https://10.0.0.5"},
			}},
			want: []string{"https://files.corp.internal", "https://10.0.0.5"},
		},
		{
			name: "integer version is accepted",
			payload: map[string]any{"downloadPolicy": map[string]any{
				"version":                1,
				"approvedPrivateOrigins": []any{"https://files.corp.internal"},
			}},
			want: []string{"https://files.corp.internal"},
		},
		{
			name: "version is not 1",
			payload: map[string]any{"downloadPolicy": map[string]any{
				"version":                float64(2),
				"approvedPrivateOrigins": []any{"https://files.corp.internal"},
			}},
			want: nil,
		},
		{
			name: "version missing",
			payload: map[string]any{"downloadPolicy": map[string]any{
				"approvedPrivateOrigins": []any{"https://files.corp.internal"},
			}},
			want: nil,
		},
		{
			name:    "policy is not an object",
			payload: map[string]any{"downloadPolicy": "https://files.corp.internal"},
			want:    nil,
		},
		{
			name: "origins are not a list",
			payload: map[string]any{"downloadPolicy": map[string]any{
				"version":                float64(1),
				"approvedPrivateOrigins": "https://files.corp.internal",
			}},
			want: nil,
		},
		{
			name: "a non-string origin discards the WHOLE list",
			payload: map[string]any{"downloadPolicy": map[string]any{
				"version":                float64(1),
				"approvedPrivateOrigins": []any{"https://files.corp.internal", 42},
			}},
			want: nil,
		},
		{
			name: "an empty origin discards the whole list",
			payload: map[string]any{"downloadPolicy": map[string]any{
				"version":                float64(1),
				"approvedPrivateOrigins": []any{"https://files.corp.internal", "   "},
			}},
			want: nil,
		},
		{
			name: "more origins than the server bound",
			payload: map[string]any{"downloadPolicy": map[string]any{
				"version":                float64(1),
				"approvedPrivateOrigins": tooManyOrigins(),
			}},
			want: nil,
		},
		{
			name: "empty list is well formed",
			payload: map[string]any{"downloadPolicy": map[string]any{
				"version":                float64(1),
				"approvedPrivateOrigins": []any{},
			}},
			want: []string{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseDownloadPolicy(tc.payload)
			if len(got) != len(tc.want) {
				t.Fatalf("parseDownloadPolicy = %v, want %v", got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Fatalf("parseDownloadPolicy = %v, want %v", got, tc.want)
				}
			}
		})
	}
}

func tooManyOrigins() []any {
	origins := make([]any, 0, 33)
	for i := 0; i < 33; i++ {
		origins = append(origins, "https://host"+string(rune('a'+i%26))+".example")
	}
	return origins
}

// ---------------------------------------------------------------------------
// Unusable allowlist: DEGRADE, never die (finding C1 of the whole-branch review)
//
// netpolicy.newOriginSet aborts on the FIRST unparseable entry, so before the
// degradation existed one bad allowlist row failed EVERY managed install
// carrying that org/site policy — public-CDN installs that need no allowlist
// entry at all included. A hand-edited settings row must not be able to deny an
// org all software deployment.
//
// These tests are deliberately NOT t.Parallel(): they swap the package-level
// log hook and reset the package-level latch. Go resumes parallel tests only
// after the sequential ones finish, so this keeps them off each other.
// ---------------------------------------------------------------------------

// swDegradedClient builds a managed-software client from a policy carrying the
// given origins, with a stub resolver and a short dialer so every assertion
// below is hermetic (203.0.113.0/24 is TEST-NET-3: unroutable, so an ALLOWED
// destination fails on connect rather than reaching anything).
func swDegradedClient(t *testing.T, origins []string) *http.Client {
	t.Helper()
	policy := managedSoftwarePolicy(origins)
	policy.Resolver = swStubResolver{"cdn.example.com": {netip.MustParseAddr("203.0.113.10")}}
	policy.Dialer = swShortDialer()
	client, err := managedSoftwareClient(policy)
	if err != nil {
		t.Fatalf("managedSoftwareClient: %v", err)
	}
	return client
}

func TestManagedSoftwareClient_UnusableAllowlistStillAllowsPublicDownloads(t *testing.T) {
	degradedOriginSetLogged.Store(nil)

	client := swDegradedClient(t, []string{"nonsense", "https://10.0.0.5"})

	// The public destination must not be refused by POLICY. It still fails —
	// TEST-NET-3 does not answer — but not with a *netpolicy.PolicyError.
	err := downloadFile(client, "https://cdn.example.com/pkg.exe", swTempFile(t))
	if err == nil {
		t.Fatal("expected a connect failure against TEST-NET-3, got nil")
	}
	var pe *netpolicy.PolicyError
	if errors.As(err, &pe) {
		t.Fatalf("public destination refused by policy after degradation: %s", pe.Reason)
	}
}

func TestManagedSoftwareClient_UnusableAllowlistFailsPrivateClosed(t *testing.T) {
	degradedOriginSetLogged.Store(nil)

	// "https://10.0.0.5" IS in the list, but the list as a whole is unusable, so
	// the approved set degrades to EMPTY — it must not be partially honoured.
	client := swDegradedClient(t, []string{"nonsense", "https://10.0.0.5"})

	err := downloadFile(client, "https://10.0.0.5/pkg.exe", swTempFile(t))
	swPolicyReason(t, err, netpolicy.ReasonPrivateAddressNotAllowed)
}

// Contrast: without the bad entry the SAME private destination is approved.
// Without this, the test above would pass even if degradation dropped nothing
// and 10.0.0.5 had simply never been reachable.
func TestManagedSoftwareClient_ParseableAllowlistStillApprovesPrivate(t *testing.T) {
	degradedOriginSetLogged.Store(nil)

	client := swDegradedClient(t, []string{"https://10.0.0.5"})

	err := downloadFile(client, "https://10.0.0.5/pkg.exe", swTempFile(t))
	var pe *netpolicy.PolicyError
	if errors.As(err, &pe) && pe.Reason == netpolicy.ReasonPrivateAddressNotAllowed {
		t.Fatalf("an approved private origin was refused: %v", err)
	}
}

// The warning is bounded: the same broken row arrives with EVERY command, and
// log shipping defaults to warn.
func TestManagedSoftwareClient_DegradationWarningIsBounded(t *testing.T) {
	degradedOriginSetLogged.Store(nil)
	original := logDegradedOriginSet
	t.Cleanup(func() { logDegradedOriginSet = original })

	var reasons []string
	logDegradedOriginSet = func(reason string) { reasons = append(reasons, reason) }

	for i := 0; i < 5; i++ {
		if _, err := managedSoftwareClient(managedSoftwarePolicy([]string{"nonsense"})); err != nil {
			t.Fatalf("managedSoftwareClient: %v", err)
		}
	}

	if len(reasons) != 1 {
		t.Fatalf("logged %d lines for one repeated reason, want 1: %v", len(reasons), reasons)
	}
	if reasons[0] != netpolicy.ReasonInvalidOrigin {
		t.Fatalf("logged reason = %q, want the bounded %q", reasons[0], netpolicy.ReasonInvalidOrigin)
	}
}

// End to end through the real entry point: a malformed allowlist must NOT
// surface as "network policy unavailable" any more, and the private
// destination it named must still be refused.
func TestInstallSoftware_MalformedApprovedOriginDegradesInsteadOfFailingConstruction(t *testing.T) {
	degradedOriginSetLogged.Store(nil)

	result := InstallSoftware(installPayload("https://10.0.0.5/pkg.exe", map[string]any{
		"version":                float64(1),
		"approvedPrivateOrigins": []any{"nonsense", "https://10.0.0.5"},
	}))

	if result.Status != "failed" {
		t.Fatalf("expected failed status, got %q", result.Status)
	}
	if strings.Contains(result.Error, "network policy unavailable") ||
		strings.Contains(result.Error, netpolicy.ReasonInvalidOrigin) {
		t.Fatalf("client construction still failed on a bad allowlist row: %q", result.Error)
	}
	if !strings.Contains(result.Error, netpolicy.ReasonPrivateAddressNotAllowed) {
		t.Fatalf("expected %q (degraded to an empty approved set), got %q",
			netpolicy.ReasonPrivateAddressNotAllowed, result.Error)
	}
}

// ---------------------------------------------------------------------------
// Destination rejections through the real InstallSoftware entry point
// ---------------------------------------------------------------------------

func TestInstallSoftware_RejectsUniversallyUnsafeDestinations(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		url  string
		// An allowlist naming the destination must not buy reachability for
		// any of these classes.
		origins    []any
		wantReason string
	}{
		{
			name:       "loopback despite an allowlist entry",
			url:        "https://127.0.0.1:8443/pkg.exe",
			origins:    []any{"https://127.0.0.1:8443"},
			wantReason: netpolicy.ReasonForbiddenAddress,
		},
		{
			name:       "link-local metadata address despite an allowlist entry",
			url:        "https://169.254.169.254/pkg.exe",
			origins:    []any{"https://169.254.169.254"},
			wantReason: netpolicy.ReasonForbiddenAddress,
		},
		{
			name:       "gcp metadata hostname",
			url:        "https://metadata.google.internal/pkg.exe",
			wantReason: netpolicy.ReasonForbiddenHostname,
		},
		{
			name:       "userinfo in the URL",
			url:        "https://user:pass@cdn.example.com/pkg.exe",
			wantReason: netpolicy.ReasonUserinfoPresent,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			policy := any(nil)
			if tc.origins != nil {
				policy = map[string]any{"version": float64(1), "approvedPrivateOrigins": tc.origins}
			}
			result := InstallSoftware(installPayload(tc.url, policy))

			if result.Status != "failed" {
				t.Fatalf("expected failed status, got %q", result.Status)
			}
			if !strings.Contains(result.Error, tc.wantReason) {
				t.Fatalf("expected reason %q in error, got %q", tc.wantReason, result.Error)
			}
		})
	}
}

// Managed software is HTTPS unconditionally: the cleartext exception exists
// only for a configured control-plane origin, which this purpose never has.
func TestInstallSoftware_RejectsCleartextEvenForAnApprovedOrigin(t *testing.T) {
	t.Parallel()

	result := InstallSoftware(installPayload("http://10.0.0.5/pkg.exe", map[string]any{
		"version":                float64(1),
		"approvedPrivateOrigins": []any{"http://10.0.0.5", "https://10.0.0.5"},
	}))

	if result.Status != "failed" {
		t.Fatalf("expected failed status, got %q", result.Status)
	}
	if !strings.Contains(result.Error, netpolicy.ReasonSchemeNotAllowed) {
		t.Fatalf("expected %q, got %q", netpolicy.ReasonSchemeNotAllowed, result.Error)
	}
}

// An RFC1918 destination with no policy (or a policy that does not name it) is
// refused at dial time — the "missing policy is compatible only for a public
// destination" rule.
func TestInstallSoftware_RejectsUnapprovedPrivateDestination(t *testing.T) {
	t.Parallel()

	t.Run("no policy at all", func(t *testing.T) {
		result := InstallSoftware(installPayload("https://10.0.0.5/pkg.exe", nil))
		if result.Status != "failed" {
			t.Fatalf("expected failed status, got %q", result.Status)
		}
		if !strings.Contains(result.Error, netpolicy.ReasonPrivateAddressNotAllowed) {
			t.Fatalf("expected %q, got %q", netpolicy.ReasonPrivateAddressNotAllowed, result.Error)
		}
	})

	t.Run("policy naming a different origin", func(t *testing.T) {
		result := InstallSoftware(installPayload("https://10.0.0.5/pkg.exe", map[string]any{
			"version":                float64(1),
			"approvedPrivateOrigins": []any{"https://files.corp.internal"},
		}))
		if !strings.Contains(result.Error, netpolicy.ReasonPrivateAddressNotAllowed) {
			t.Fatalf("expected %q, got %q", netpolicy.ReasonPrivateAddressNotAllowed, result.Error)
		}
	})

	t.Run("IPv6 ULA", func(t *testing.T) {
		result := InstallSoftware(installPayload("https://[fd00::5]/pkg.exe", nil))
		if !strings.Contains(result.Error, netpolicy.ReasonPrivateAddressNotAllowed) {
			t.Fatalf("expected %q, got %q", netpolicy.ReasonPrivateAddressNotAllowed, result.Error)
		}
	})
}

// Log/report hygiene: a download failure must never carry the request URL —
// managed software URLs are presigned and carry capability query strings.
// net/http wraps every transport error in *url.Error, whose Error() repeats
// the full URL, so this is a live hazard, not a theoretical one.
func TestInstallSoftware_ErrorNeverLeaksTheDownloadURL(t *testing.T) {
	t.Parallel()

	const secret = "X-Amz-Signature=deadbeefcafe"
	result := InstallSoftware(installPayload("https://10.0.0.5/pkg.exe?"+secret, nil))

	if result.Status != "failed" {
		t.Fatalf("expected failed status, got %q", result.Status)
	}
	if strings.Contains(result.Error, secret) || strings.Contains(result.Error, "10.0.0.5") {
		t.Fatalf("download error leaked the URL: %q", result.Error)
	}
}

// ---------------------------------------------------------------------------
// DNS rebinding and hostile resolver answers (through the real client)
// ---------------------------------------------------------------------------

func TestDownloadFile_HostileResolverAnswerRejected(t *testing.T) {
	t.Parallel()

	client := swClient(t, nil, func(p *netpolicy.Policy) {
		p.Resolver = swStubResolver{"cdn.example.com": {netip.MustParseAddr("169.254.169.254")}}
		p.Dialer = swShortDialer()
	})

	err := downloadFile(client, "https://cdn.example.com/pkg.exe", swTempFile(t))
	swPolicyReason(t, err, netpolicy.ReasonForbiddenAddress)
}

func TestDownloadFile_MixedResolverAnswerRejected(t *testing.T) {
	t.Parallel()

	client := swClient(t, nil, func(p *netpolicy.Policy) {
		p.Resolver = swStubResolver{"cdn.example.com": {
			netip.MustParseAddr("203.0.113.10"),
			netip.MustParseAddr("10.0.0.5"),
		}}
		p.Dialer = swShortDialer()
	})

	err := downloadFile(client, "https://cdn.example.com/pkg.exe", swTempFile(t))
	swPolicyReason(t, err, netpolicy.ReasonPrivateAddressNotAllowed)
}

// A public hostname that resolves to a private address is refused unless the
// EXACT origin is approved — the DNS-rebinding case a capability-0 agent
// cannot defend against at all.
func TestDownloadFile_PrivateAnswerForPublicHostnameNeedsTheExactOrigin(t *testing.T) {
	t.Parallel()

	resolver := swStubResolver{"files.corp.internal": {netip.MustParseAddr("10.0.0.5")}}

	t.Run("unapproved", func(t *testing.T) {
		client := swClient(t, []string{"https://other.corp.internal"}, func(p *netpolicy.Policy) {
			p.Resolver = resolver
			p.Dialer = swShortDialer()
		})
		err := downloadFile(client, "https://files.corp.internal/pkg.exe", swTempFile(t))
		swPolicyReason(t, err, netpolicy.ReasonPrivateAddressNotAllowed)
	})

	t.Run("approved reaches the dial", func(t *testing.T) {
		// Nothing listens at 10.0.0.5, so this necessarily fails — the
		// assertion is that it is NOT a policy rejection, i.e. the approved
		// origin really did grant private reachability.
		client := swClient(t, []string{"https://files.corp.internal"}, func(p *netpolicy.Policy) {
			p.Resolver = resolver
			p.Dialer = swShortDialer()
		})
		err := downloadFile(client, "https://files.corp.internal/pkg.exe", swTempFile(t))
		if err == nil {
			t.Fatal("expected a network error — nothing listens at the test address")
		}
		var pe *netpolicy.PolicyError
		if errors.As(err, &pe) && pe.Reason == netpolicy.ReasonPrivateAddressNotAllowed {
			t.Fatalf("approved private origin was policy-rejected: %v", err)
		}
	})
}

// The same acceptance property for an IPv6 ULA destination.
func TestDownloadFile_ApprovedULAReachesTheDial(t *testing.T) {
	t.Parallel()

	client := swClient(t, []string{"https://[fd00::5]"}, func(p *netpolicy.Policy) {
		p.Dialer = swShortDialer()
	})

	err := downloadFile(client, "https://[fd00::5]/pkg.exe", swTempFile(t))
	if err == nil {
		t.Fatal("expected a network error — nothing listens at the test address")
	}
	var pe *netpolicy.PolicyError
	if errors.As(err, &pe) && pe.Reason == netpolicy.ReasonPrivateAddressNotAllowed {
		t.Fatalf("approved ULA origin was policy-rejected: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Redirect policy (direct CheckRedirect calls — no network)
// ---------------------------------------------------------------------------

func TestManagedSoftwareClient_RedirectPolicy(t *testing.T) {
	t.Parallel()

	client := swClient(t, []string{"https://files.corp.internal"}, nil)
	initial := swMustRequest(t, "https://cdn.example.com/pkg.exe")

	// A cleartext redirect target is refused as scheme_not_allowed rather than
	// scheme_downgrade: redirectPolicy re-runs the full URL validation before
	// the downgrade comparison, and for ManagedSoftwareDownload plain HTTP is
	// never a valid target in the first place (the cleartext exception belongs
	// to a configured control-plane origin only). Either reason is a refusal;
	// what matters is that the hop cannot proceed over cleartext.
	t.Run("https downgrade", func(t *testing.T) {
		err := client.CheckRedirect(swMustRequest(t, "http://cdn.example.com/pkg.exe"), []*http.Request{initial})
		swPolicyReason(t, err, netpolicy.ReasonSchemeNotAllowed)
	})

	t.Run("hop to loopback", func(t *testing.T) {
		err := client.CheckRedirect(swMustRequest(t, "https://127.0.0.1:8443/pkg.exe"), []*http.Request{initial})
		swPolicyReason(t, err, netpolicy.ReasonForbiddenAddress)
	})

	t.Run("hop to metadata", func(t *testing.T) {
		err := client.CheckRedirect(swMustRequest(t, "https://169.254.169.254/pkg.exe"), []*http.Request{initial})
		swPolicyReason(t, err, netpolicy.ReasonForbiddenAddress)
	})

	t.Run("ten hop limit", func(t *testing.T) {
		via := make([]*http.Request, 0, 11)
		for i := 0; i < 11; i++ {
			via = append(via, swMustRequest(t, "https://cdn.example.com/hop"))
		}
		err := client.CheckRedirect(swMustRequest(t, "https://cdn.example.com/hop"), via)
		swPolicyReason(t, err, netpolicy.ReasonTooManyRedirects)

		if err := client.CheckRedirect(swMustRequest(t, "https://cdn.example.com/hop"), via[:9]); err != nil {
			t.Fatalf("9 prior hops should be permitted, got %v", err)
		}
	})

	t.Run("cross-origin public hop is permitted and strips credentials", func(t *testing.T) {
		next := swMustRequest(t, "https://mirror.example.net/pkg.exe")
		next.Header.Set("Authorization", "Bearer secret-token")
		next.Header.Set("Cookie", "sid=1")
		next.Header.Set("Proxy-Authorization", "Basic cHJveHk=")

		if err := client.CheckRedirect(next, []*http.Request{initial}); err != nil {
			t.Fatalf("cross-origin https redirect should be permitted: %v", err)
		}
		for _, h := range []string{"Authorization", "Cookie", "Proxy-Authorization"} {
			if got := next.Header.Get(h); got != "" {
				t.Fatalf("%s must be stripped on origin change, got %q", h, got)
			}
		}
	})
}

// A redirect that leaves the allowlist for an unapproved private address is
// refused at dial time on the hop, not silently followed.
func TestDownloadFile_RedirectOutsideTheAllowlistRejected(t *testing.T) {
	t.Parallel()

	client := swClient(t, []string{"https://files.corp.internal"}, func(p *netpolicy.Policy) {
		p.Resolver = swStubResolver{"evil.example.com": {netip.MustParseAddr("192.168.1.10")}}
		p.Dialer = swShortDialer()
	})

	err := downloadFile(client, "https://evil.example.com/pkg.exe", swTempFile(t))
	swPolicyReason(t, err, netpolicy.ReasonPrivateAddressNotAllowed)
}

// ---------------------------------------------------------------------------
// Environment proxy
// ---------------------------------------------------------------------------

// A hostile HTTP_PROXY/HTTPS_PROXY must never be consulted. The target must be
// a destination that PASSES validation (a stub-resolved public address) so a
// real dial is attempted: with a proxy configured, the transport would dial
// the PROXY's loopback address instead, which surfaces as forbidden_address.
// With Proxy nil, the dial targets the stub-resolved public address and the
// failure is an ordinary network error.
func TestDownloadFile_IgnoresHostileProxyEnvironment(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:9/")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:9/")
	t.Setenv("http_proxy", "http://127.0.0.1:9/")
	t.Setenv("ALL_PROXY", "http://127.0.0.1:9/")
	t.Setenv("NO_PROXY", "")

	client := swClient(t, nil, func(p *netpolicy.Policy) {
		p.Resolver = swStubResolver{"cdn.example.com": {netip.MustParseAddr("203.0.113.10")}}
		p.Dialer = swShortDialer()
	})

	err := downloadFile(client, "https://cdn.example.com/pkg.exe", swTempFile(t))
	if err == nil {
		t.Fatal("expected an error — nothing listens at the stub-resolved address")
	}
	var pe *netpolicy.PolicyError
	if errors.As(err, &pe) && pe.Reason == netpolicy.ReasonForbiddenAddress {
		t.Fatalf("dial targeted a loopback address — HTTP_PROXY was consulted: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Bounded copy (real local server, explicit bypass client — see file header)
// ---------------------------------------------------------------------------

func TestDownloadFile_OversizedPackageRejected(t *testing.T) {
	old := maxInstallFileSize
	maxInstallFileSize = 32
	t.Cleanup(func() { maxInstallFileSize = old })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("A", int(maxInstallFileSize)+1)))
	}))
	defer server.Close()

	err := downloadFile(server.Client(), server.URL+"/pkg.exe", swTempFile(t))
	if err == nil {
		t.Fatal("expected the oversized package to be rejected")
	}
	if !errors.Is(err, netpolicy.ErrResponseTooLarge) {
		t.Fatalf("expected ErrResponseTooLarge in the chain, got %v", err)
	}
}

func TestDownloadFile_WritesThePackage(t *testing.T) {
	body := []byte("installer-bytes")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(body)
	}))
	defer server.Close()

	dest := swTempFile(t)
	if err := downloadFile(server.Client(), server.URL+"/pkg.exe", dest); err != nil {
		t.Fatalf("downloadFile: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != string(body) {
		t.Fatalf("downloaded %q, want %q", got, body)
	}
}

// safeDownloadError is what keeps a *url.Error's full-URL text out of every
// reported install failure.
func TestSafeDownloadError(t *testing.T) {
	t.Parallel()

	const secretURL = "https://cdn.example.com/pkg.exe?X-Amz-Signature=deadbeef"

	t.Run("policy error yields the bounded reason", func(t *testing.T) {
		err := &url.Error{Op: "Get", URL: secretURL, Err: &netpolicy.PolicyError{Reason: netpolicy.ReasonForbiddenAddress}}
		if got := safeDownloadError(err); got != netpolicy.ReasonForbiddenAddress {
			t.Fatalf("safeDownloadError = %q, want %q", got, netpolicy.ReasonForbiddenAddress)
		}
	})

	t.Run("ordinary transport error is stripped of the URL", func(t *testing.T) {
		err := &url.Error{Op: "Get", URL: secretURL, Err: errors.New("connection reset by peer")}
		got := safeDownloadError(err)
		if strings.Contains(got, "X-Amz-Signature") || strings.Contains(got, "cdn.example.com") {
			t.Fatalf("safeDownloadError leaked the URL: %q", got)
		}
		if got != "connection reset by peer" {
			t.Fatalf("safeDownloadError = %q", got)
		}
	})

	t.Run("plain error is unchanged", func(t *testing.T) {
		if got := safeDownloadError(errors.New("checksum mismatch")); got != "checksum mismatch" {
			t.Fatalf("safeDownloadError = %q", got)
		}
	})

	t.Run("nil error is empty", func(t *testing.T) {
		if got := safeDownloadError(nil); got != "" {
			t.Fatalf("safeDownloadError(nil) = %q, want empty", got)
		}
	})

	t.Run("url.Error with a nil inner error does not panic", func(t *testing.T) {
		// This function used to be a FORK of updater.SafeDownloadErrorFields and
		// dereferenced urlErr.Err unconditionally. It now delegates, so the nil
		// guard added there covers this call site too — which matters because
		// every caller is on a failure path inside a command-worker goroutine,
		// where a nil dereference is a process crash rather than a failed
		// install.
		got := safeDownloadError(&url.Error{Op: "Get", URL: secretURL})
		if got == "" {
			t.Fatal("safeDownloadError returned empty for a nil-Err url.Error")
		}
		if strings.Contains(got, "X-Amz-Signature") || strings.Contains(got, "cdn.example.com") {
			t.Fatalf("nil-Err fallback leaked the URL: %q", got)
		}
	})
}
