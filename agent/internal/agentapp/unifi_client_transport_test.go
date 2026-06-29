package agentapp

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/secmem"
)

// The UniFi collector's Breeze-API client must (1) inject the agent bearer token
// and (2) refuse to follow redirects, so the fleet credential can never be
// replayed to an attacker-controlled Location host. Regression guard for the
// token-injecting, redirect-guarded transport wiring.
func TestNewUnifiAPIClientInjectsTokenAndRefusesRedirects(t *testing.T) {
	var secondHits int32
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&secondHits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer second.Close()

	var gotAuth string
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		http.Redirect(w, r, second.URL, http.StatusFound)
	}))
	defer first.Close()

	client := newUnifiAPIClient(secmem.NewSecureString("agent-token"), nil)
	resp, err := client.Get(first.URL)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	if gotAuth != "Bearer agent-token" {
		t.Fatalf("expected bearer token injected on the first request, got %q", gotAuth)
	}
	if n := atomic.LoadInt32(&secondHits); n != 0 {
		t.Fatalf("client followed redirect to second host (%d hits) — token-leak guard missing", n)
	}
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("expected the 302 surfaced (ErrUseLastResponse), got %d", resp.StatusCode)
	}
}
