package storagesession

import (
	"crypto/tls"
	"io"
	"net/http"
	"testing"

	"github.com/breeze-rmm/agent/internal/ech/echtest"
)

// Storage-session control calls go to the agent's server_url, so behind an
// SNI filter they need the shared ECH dialer (#8869). The rig answers 421
// unless ECH was accepted. The client certificate config is cloned, never
// shared, and redirects stay refused.
func TestControlClient_DialsTLSThroughECH(t *testing.T) {
	rig := echtest.Start(t, "control.echtest.invalid", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "https://elsewhere.invalid/", http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	clientTLS := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: rig.Pool}
	c := controlClient(nil, clientTLS)

	get := func(path string) int {
		t.Helper()
		resp, err := c.Get(rig.URL(path))
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		return resp.StatusCode
	}
	if got := get("/api/v1/backup/storage-session/control"); got != http.StatusOK {
		t.Fatalf("status = %d, want 200 (421 = TLS dial did not use ECH)", got)
	}
	if got := get("/redirect"); got != http.StatusFound {
		t.Fatalf("redirect status = %d, want 302 unfollowed", got)
	}
	tr := c.Transport.(*http.Transport)
	if tr.TLSClientConfig == clientTLS {
		t.Fatal("client TLS config must be cloned, not shared")
	}
	if tr.Proxy == nil {
		t.Fatal("Proxy dropped: DefaultTransport proxy semantics must be kept")
	}
}
