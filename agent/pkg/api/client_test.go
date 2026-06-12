package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// crossHostURL rewrites an httptest server URL (always 127.0.0.1) to a different
// hostname so it models a redirect that leaves the agent's trusted host. The
// target is never actually dialed in these tests — the redirect is refused
// first — so it only needs a distinct hostname.
func crossHostURL(serverURL, path string) string {
	return strings.Replace(serverURL, "127.0.0.1", "localhost", 1) + path
}

func TestErrHTTPStatus_Error(t *testing.T) {
	err := &ErrHTTPStatus{StatusCode: 401, Body: `{"error":"invalid key"}`}
	got := err.Error()
	want := `http 401: {"error":"invalid key"}`
	if got != want {
		t.Errorf("Error() = %q, want %q", got, want)
	}
}

func TestErrHTTPStatus_ErrorsAs(t *testing.T) {
	var wrapped error = &ErrHTTPStatus{StatusCode: 404, Body: "not found"}
	var target *ErrHTTPStatus
	if !errors.As(wrapped, &target) {
		t.Fatal("errors.As should match *ErrHTTPStatus")
	}
	if target.StatusCode != 404 {
		t.Errorf("StatusCode = %d, want 404", target.StatusCode)
	}
}

func TestRotateToken(t *testing.T) {
	t.Parallel()

	var sawAuth string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path != "/api/v1/agents/agent-1/rotate-token" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"authToken":"brz_rotated","watchdogAuthToken":"brz_watchdog","helperAuthToken":"brz_helper","rotatedAt":"2026-03-31T20:00:00Z"}`))
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "brz_old", "agent-1")
	resp, err := client.RotateToken()
	if err != nil {
		t.Fatalf("RotateToken() error = %v", err)
	}
	if sawAuth != "Bearer brz_old" {
		t.Fatalf("Authorization header = %q, want %q", sawAuth, "Bearer brz_old")
	}
	if resp.AuthToken != "brz_rotated" {
		t.Fatalf("AuthToken = %q, want %q", resp.AuthToken, "brz_rotated")
	}
	if resp.WatchdogAuthToken != "brz_watchdog" {
		t.Fatalf("WatchdogAuthToken = %q, want %q", resp.WatchdogAuthToken, "brz_watchdog")
	}
	if resp.HelperAuthToken != "brz_helper" {
		t.Fatalf("HelperAuthToken = %q, want %q", resp.HelperAuthToken, "brz_helper")
	}
	if resp.RotatedAt != "2026-03-31T20:00:00Z" {
		t.Fatalf("RotatedAt = %q, want %q", resp.RotatedAt, "2026-03-31T20:00:00Z")
	}
}

func TestEnrollPresentsReenrollToken(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		clientToken string
		wantHeader  string
	}{
		{name: "force re-enroll presents existing token", clientToken: "brz_existing", wantHeader: "brz_existing"},
		{name: "fresh enroll omits the header", clientToken: "", wantHeader: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var sawReenroll string
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sawReenroll = r.Header.Get("x-agent-reenrollment-token")
				if r.Method != http.MethodPost || r.URL.Path != "/api/v1/agents/enroll" {
					w.WriteHeader(http.StatusNotFound)
					return
				}
				_, _ = w.Write([]byte(`{"agentId":"agent-1","authToken":"brz_new"}`))
			}))
			defer ts.Close()

			client := NewClient(ts.URL, tt.clientToken, "agent-1")
			resp, err := client.Enroll(&EnrollRequest{EnrollmentKey: "key", Hostname: "host-1"})
			if err != nil {
				t.Fatalf("Enroll() error = %v", err)
			}
			if resp.AgentID != "agent-1" {
				t.Fatalf("AgentID = %q, want %q", resp.AgentID, "agent-1")
			}
			if sawReenroll != tt.wantHeader {
				t.Fatalf("x-agent-reenrollment-token = %q, want %q", sawReenroll, tt.wantHeader)
			}
		})
	}
}

// refuseUntrustedRedirect is the http.Client.CheckRedirect policy. It must
// reject any redirect that would carry the agent's credentials off the endpoint
// the request originally targeted, and allow trusted same-endpoint redirects.
// See #1043.
func TestRefuseUntrustedRedirect(t *testing.T) {
	t.Parallel()

	mustReq := func(rawURL string) *http.Request {
		r, err := http.NewRequest(http.MethodGet, rawURL, nil)
		if err != nil {
			t.Fatalf("bad url %q: %v", rawURL, err)
		}
		return r
	}

	tests := []struct {
		name    string
		target  string
		prev    string
		wantErr bool
	}{
		{name: "same host and scheme, different path", target: "https://api.example.com/b", prev: "https://api.example.com/a", wantErr: false},
		{name: "http to https upgrade on same host", target: "https://api.example.com/b", prev: "http://api.example.com/a", wantErr: false},
		{name: "host comparison is case-insensitive", target: "https://API.Example.com/b", prev: "https://api.example.com/a", wantErr: false},
		{name: "different port on same host is allowed", target: "https://api.example.com:8443/b", prev: "https://api.example.com/a", wantErr: false},
		{name: "different host is refused", target: "https://evil.example.com/b", prev: "https://api.example.com/a", wantErr: true},
		{name: "https to http downgrade is refused", target: "http://api.example.com:8443/b", prev: "https://api.example.com:8443/a", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := refuseUntrustedRedirect(mustReq(tt.target), []*http.Request{mustReq(tt.prev)})
			if (err != nil) != tt.wantErr {
				t.Fatalf("refuseUntrustedRedirect() error = %v, wantErr = %v", err, tt.wantErr)
			}
		})
	}

	// The first call (no prior hops) must always be allowed.
	if err := refuseUntrustedRedirect(mustReq("https://api.example.com/a"), nil); err != nil {
		t.Fatalf("empty via should be allowed, got %v", err)
	}
}

// A compromised or MITM'd server can answer the enroll request with a redirect
// to a host it controls. Stripping the token would not be enough: following the
// redirect still hands the enrollment body (hostname, hardware serial, OS info)
// to the attacker and lets it forge the EnrollResponse the agent persists. The
// client must refuse the redirect outright and never contact the other host.
// See #1043.
func TestEnrollRefusesCrossHostRedirect(t *testing.T) {
	t.Parallel()

	var attackerHits int
	attacker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attackerHits++
		_, _ = w.Write([]byte(`{"agentId":"attacker","authToken":"brz_evil"}`))
	}))
	defer attacker.Close()

	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, crossHostURL(attacker.URL, "/api/v1/agents/enroll"), http.StatusTemporaryRedirect)
	}))
	defer origin.Close()

	client := NewClient(origin.URL, "brz_existing", "agent-1")
	resp, err := client.Enroll(&EnrollRequest{EnrollmentKey: "key", Hostname: "host-1"})
	if err == nil {
		t.Fatalf("Enroll() should refuse the cross-host redirect, got resp = %+v", resp)
	}
	if attackerHits != 0 {
		t.Fatalf("agent contacted attacker host %d time(s); the request must never be sent there", attackerHits)
	}
}

// The same protection applies to every credentialed call, not just Enroll,
// because all methods share one http.Client. RotateToken sends the device token
// as Authorization: Bearer, which must never follow a cross-host redirect.
func TestAuthenticatedRequestRefusesCrossHostRedirect(t *testing.T) {
	t.Parallel()

	var attackerHits int
	attacker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attackerHits++
		_, _ = w.Write([]byte(`{"authToken":"brz_evil"}`))
	}))
	defer attacker.Close()

	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, crossHostURL(attacker.URL, "/rotate"), http.StatusTemporaryRedirect)
	}))
	defer origin.Close()

	client := NewClient(origin.URL, "brz_token", "agent-1")
	if _, err := client.RotateToken(); err == nil {
		t.Fatal("RotateToken() should refuse the cross-host redirect")
	}
	if attackerHits != 0 {
		t.Fatalf("Authorization header would have leaked: attacker contacted %d time(s)", attackerHits)
	}
}

// NewClientWithTLS (the mTLS production path) must wire the same redirect
// policy as NewClient — exercised here so a regression in that constructor
// cannot ship silently.
func TestEnrollWithTLSClientRefusesCrossHostRedirect(t *testing.T) {
	t.Parallel()

	var attackerHits int
	attacker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attackerHits++
		_, _ = w.Write([]byte(`{"agentId":"attacker"}`))
	}))
	defer attacker.Close()

	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, crossHostURL(attacker.URL, "/api/v1/agents/enroll"), http.StatusTemporaryRedirect)
	}))
	defer origin.Close()

	client := NewClientWithTLS(origin.URL, "brz_existing", "agent-1", nil)
	if _, err := client.Enroll(&EnrollRequest{EnrollmentKey: "key", Hostname: "host-1"}); err == nil {
		t.Fatal("Enroll() via NewClientWithTLS should refuse the cross-host redirect")
	}
	if attackerHits != 0 {
		t.Fatalf("TLS client contacted attacker host %d time(s)", attackerHits)
	}
}

// A same-endpoint redirect (e.g. a path redirect from the legitimate server) is
// trusted, so the token must still reach the final hop — otherwise refusing it
// would break legitimate re-enrollment.
func TestEnrollKeepsReenrollTokenOnSameHostRedirect(t *testing.T) {
	t.Parallel()

	var finalSawToken string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/agents/enroll":
			http.Redirect(w, r, "/api/v1/agents/enroll-final", http.StatusTemporaryRedirect)
		case "/api/v1/agents/enroll-final":
			finalSawToken = r.Header.Get("x-agent-reenrollment-token")
			_, _ = w.Write([]byte(`{"agentId":"agent-1","authToken":"brz_new"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "brz_existing", "agent-1")
	if _, err := client.Enroll(&EnrollRequest{EnrollmentKey: "key", Hostname: "host-1"}); err != nil {
		t.Fatalf("Enroll() error = %v", err)
	}
	if finalSawToken != "brz_existing" {
		t.Fatalf("same-host redirect should preserve re-enrollment token, got %q", finalSawToken)
	}
}
