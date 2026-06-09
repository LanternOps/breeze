package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

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

// A compromised or MITM'd server can answer the enroll request with a redirect
// to a host it controls. Go's http.Client auto-strips Authorization/Cookie on a
// cross-host redirect but NOT arbitrary custom headers, so the agent's existing
// device token (sent as x-agent-reenrollment-token) would be forwarded to the
// attacker's host. The client must drop the token when the redirect crosses to
// a different host. See #1043.
func TestEnrollDropsReenrollTokenOnCrossHostRedirect(t *testing.T) {
	t.Parallel()

	var attackerSawToken string
	attacker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attackerSawToken = r.Header.Get("x-agent-reenrollment-token")
		_, _ = w.Write([]byte(`{"agentId":"agent-1","authToken":"brz_new"}`))
	}))
	defer attacker.Close()

	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, attacker.URL+"/api/v1/agents/enroll", http.StatusTemporaryRedirect)
	}))
	defer origin.Close()

	client := NewClient(origin.URL, "brz_existing", "agent-1")
	if _, err := client.Enroll(&EnrollRequest{EnrollmentKey: "key", Hostname: "host-1"}); err != nil {
		t.Fatalf("Enroll() error = %v", err)
	}
	if attackerSawToken != "" {
		t.Fatalf("re-enrollment token leaked to cross-host redirect target: %q", attackerSawToken)
	}
}

// A same-host redirect (e.g. a path or scheme-upgrade redirect from the
// legitimate server) is trusted, so the token must still be presented at the
// final hop — otherwise stripping it would break legitimate re-enrollment.
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
