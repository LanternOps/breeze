package isolation

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// The verify call carries the agent credential; a redirect answered by the
// server must not take it, or the request, to another host or port.
func TestHTTPVerifierKeepsRedirectsOnServerHost(t *testing.T) {
	for _, target := range []string{
		"http://other.example.test/next",
		"http://sub.control.example.test/next",
		"http://control.example.test:8080/next",
	} {
		t.Run(target, func(t *testing.T) {
			var (
				mu      sync.Mutex
				reached []string
			)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				if r.Host == "control.example.test" {
					http.Redirect(w, r, target, http.StatusTemporaryRedirect)
					return
				}
				mu.Lock()
				reached = append(reached, r.Host+" "+r.Header.Get("Authorization"))
				mu.Unlock()
				w.WriteHeader(http.StatusOK)
			}))
			defer srv.Close()
			// Every host name dials the one test server.
			dial := func(ctx context.Context, network, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, network, srv.Listener.Addr().String())
			}
			verify := NewHTTPVerifier(HTTPVerifierConfig{
				URL:         DefaultVerifyURL("http://control.example.test", "agent-id"),
				Header:      func() http.Header { return http.Header{"Authorization": {"Bearer t0k"}} },
				DialContext: dial,
				Timeout:     5 * time.Second,
			})
			_, err := verify(context.Background(), idA)
			mu.Lock()
			defer mu.Unlock()
			if len(reached) != 0 {
				t.Fatalf("redirect was followed: %s", strings.Join(reached, "; "))
			}
			if err == nil {
				t.Fatal("verify succeeded through an off-host redirect")
			}
		})
	}
}
