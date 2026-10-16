package agentapp

import (
	"crypto/tls"
	"io"
	"net/http"
	"testing"

	"github.com/breeze-rmm/agent/internal/ech/echtest"
	"github.com/breeze-rmm/agent/internal/secmem"
)

// Lab finding (#8869): behind an SNI filter the device heartbeated fine over
// ECH while these control-plane clients failed with "server gave HTTP response
// to HTTPS client". The rig serves only ECH-accepted handshakes (421
// otherwise), so a 200 proves the client's TLS dial went through the shared
// ECH dialer.

const echControlHost = "control.echtest.invalid"

func echGet(t *testing.T, c *http.Client, url string) *http.Response {
	t.Helper()
	resp, err := c.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp
}

// newUnifiAPIClient backs the UniFi collector config fetch and the workspace
// index crawl-config client. ECH must not cost it the bearer token or the
// redirect refusal.
func TestNewUnifiAPIClient_DialsTLSThroughECH(t *testing.T) {
	var gotAuth string
	rig := echtest.Start(t, echControlHost, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "https://elsewhere.invalid/", http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	c := newUnifiAPIClient(secmem.NewSecureString("agent-token"), &tls.Config{RootCAs: rig.Pool})

	if got := echGet(t, c, rig.URL("/api/v1/agents/a1/unifi-collectors")).StatusCode; got != http.StatusOK {
		t.Fatalf("status = %d, want 200 (421 = TLS dial did not use ECH)", got)
	}
	if gotAuth != "Bearer agent-token" {
		t.Fatalf("Authorization = %q, want bearer token", gotAuth)
	}
	if got := echGet(t, c, rig.URL("/redirect")).StatusCode; got != http.StatusFound {
		t.Fatalf("redirect status = %d, want the 302 surfaced unfollowed", got)
	}
}

// firstInstallHTTPClient stages the first agent release; in hosted mode it
// stages from the control plane (#5899).
func TestFirstInstallHTTPClient_DialsTLSThroughECH(t *testing.T) {
	rig := echtest.Start(t, echControlHost, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	c := firstInstallHTTPClient()
	tr, ok := c.Transport.(*http.Transport)
	if !ok || tr.TLSClientConfig == nil {
		t.Fatalf("Transport = %T (TLS config %v), want *http.Transport with a TLS config", c.Transport, ok)
	}
	tr.TLSClientConfig.RootCAs = rig.Pool
	if got := echGet(t, c, rig.URL("/api/v1/agents/download/linux/amd64")).StatusCode; got != http.StatusOK {
		t.Fatalf("status = %d, want 200 (421 = TLS dial did not use ECH)", got)
	}
	if c.Timeout != releaseDownloadTimeout || c.CheckRedirect == nil {
		t.Fatalf("timeout/redirect policy lost: %v %v", c.Timeout, c.CheckRedirect != nil)
	}
}
