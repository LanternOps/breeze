package isolation

import (
	"context"
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

func negHarness(mode dialMode) (*fakeIsolator, *fakeDialer) {
	log := &callLog{}
	iso := newFakeIsolator(log)
	iso.installed = true
	return iso, &fakeDialer{log: log, iso: iso, mode: mode}
}

var probeTarget = netip.MustParseAddrPort("192.0.2.10:80")

func TestNegativeProbePassesOnlyOnAttributedLocalDrop(t *testing.T) {
	cases := []struct {
		name string
		mode dialMode
		ok   bool
	}{
		{"timeout with our drop observed", dialDrop, true},
		{"local permission error with our drop observed", dialLocalDenied, true},
		{"timeout without our drop (upstream blackhole)", dialDropUnattributed, false},
		{"connect succeeds", dialConnect, false},
		{"RST", dialReset, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			iso, d := negHarness(tc.mode)
			err := negativeProbe(context.Background(), d, iso, probeTarget, 50*time.Millisecond)
			if tc.ok && err != nil {
				t.Fatalf("probe failed: %v", err)
			}
			if !tc.ok {
				if err == nil {
					t.Fatal("probe passed")
				}
				if code := probeFailureCode(err); code != FailEnforcementNotObserved {
					t.Fatalf("failure code = %q", code)
				}
			}
		})
	}
}

// A dialer that ignores the deadline and only gives up later than the local
// timeout (plus grace) is not a local drop.
func TestNegativeProbeTooSlowFails(t *testing.T) {
	iso, d := negHarness(dialDrop)
	d.ignoreCtx = 50*time.Millisecond + negativeGrace + 100*time.Millisecond
	if err := negativeProbe(context.Background(), d, iso, probeTarget, 50*time.Millisecond); err == nil {
		t.Fatal("a drop slower than the local timeout passed")
	}
}

func TestNegativeProbeTimeoutDefault(t *testing.T) {
	if NegativeProbeTimeout != 3*time.Second {
		t.Fatalf("negative probe local timeout = %v, want 3s", NegativeProbeTimeout)
	}
}

func TestNegativeProbePort(t *testing.T) {
	cases := []struct {
		permitted []uint16
		want      uint16
	}{
		{[]uint16{443}, 80},
		{[]uint16{443, 80}, 444},
		{[]uint16{8443}, 8444},
		{[]uint16{65535}, 65534},
		{[]uint16{3478, 3479}, 3477},
	}
	for _, tc := range cases {
		if got := negativeProbePort(tc.permitted); got != tc.want {
			t.Errorf("permitted %v: port %d, want %d", tc.permitted, got, tc.want)
		}
	}
}

func TestNegativeProbeTargetFromSpec(t *testing.T) {
	spec := ResolvedSpec{Entries: []ResolvedEntry{
		{AllowEntry: AllowEntry{Kind: KindHost, Host: controlHost, Proto: ProtoTCP, Ports: []uint16{443}, Scope: ScopeBreeze},
			Addrs: []netip.Prefix{netip.MustParsePrefix("192.0.2.10/32"), netip.MustParsePrefix("2001:db8::10/128")}},
		// Another entry permits port 80 on the same address: the probe must not use 80.
		{AllowEntry: AllowEntry{Kind: KindCIDR, CIDR: "192.0.2.0/24", Proto: ProtoTCP, Ports: []uint16{80}, Scope: ScopeBreeze},
			Addrs: []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")}},
	}}
	target, err := negativeProbeTarget(spec)
	if err != nil {
		t.Fatal(err)
	}
	if target.Addr() != netip.MustParseAddr("192.0.2.10") || target.Port() == 80 || target.Port() == 443 {
		t.Fatalf("target = %v", target)
	}
	if _, err := negativeProbeTarget(ResolvedSpec{}); err == nil {
		t.Fatal("an empty spec has no probe target")
	}
}

func TestHTTPVerifierUsesAFreshConnectionEachTime(t *testing.T) {
	var mu sync.Mutex
	newConns := 0
	var paths []string
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization"))
		mu.Unlock()
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			mu.Lock()
			newConns++
			mu.Unlock()
		}
	}
	srv.StartTLS()
	defer srv.Close()

	verify := NewHTTPVerifier(HTTPVerifierConfig{
		URL:       DefaultVerifyURL(srv.URL),
		Header:    func() http.Header { return http.Header{"Authorization": {"Bearer t0k"}} },
		TLSConfig: srv.Client().Transport.(*http.Transport).TLSClientConfig,
		Timeout:   5 * time.Second,
	})
	for i := 0; i < 2; i++ {
		at, err := verify(context.Background(), idA)
		if err != nil {
			t.Fatalf("verify %d: %v", i, err)
		}
		if d := time.Since(at); d < -5*time.Second || d > 5*time.Second {
			t.Fatalf("server time %v not taken from the Date header", at)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if newConns != 2 {
		t.Fatalf("%d new connections for 2 probes, want a fresh TLS session each time", newConns)
	}
	want := "POST /api/v1/agents/isolation/" + idA + "/verify Bearer t0k"
	if paths[0] != want {
		t.Fatalf("request %q, want %q", paths[0], want)
	}
}

func TestHTTPVerifierRejectsNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusConflict)
	}))
	defer srv.Close()
	verify := NewHTTPVerifier(HTTPVerifierConfig{URL: DefaultVerifyURL(srv.URL), Timeout: 2 * time.Second})
	_, err := verify(context.Background(), idA)
	if err == nil || !strings.Contains(err.Error(), "409") {
		t.Fatalf("err = %v, want a 409 failure", err)
	}
}

func TestProbeFailureCodes(t *testing.T) {
	if probeFailureCode(errPositive("x")) != FailControlPlaneUnreachable {
		t.Fatal("positive probe failure code")
	}
	if probeFailureCode(errNegative("x")) != FailEnforcementNotObserved {
		t.Fatal("negative probe failure code")
	}
}
