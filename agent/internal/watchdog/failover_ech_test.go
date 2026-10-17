package watchdog

import (
	"crypto/tls"
	"net"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/ech/echtest"
)

func TestFailoverTransport_UsesECHDialer(t *testing.T) {
	tr := newFailoverTransport(&tls.Config{MinVersion: tls.VersionTLS12})
	if tr.DialTLSContext == nil {
		t.Fatal("DialTLSContext must be the ECH dialer")
	}
	if tr.ForceAttemptHTTP2 {
		t.Fatal("failover must stay HTTP/1.1")
	}
	if tr.DialContext == nil {
		t.Fatal("DialContext must be set (netcache)")
	}
	if tr.Proxy == nil {
		t.Fatal("Proxy must be set (DefaultTransport clone)")
	}
}

// End to end: a request through the failover client reaches a server that
// answers 421 unless ECH was accepted, and the handshake negotiates only
// http/1.1. The URL carries the rig's real port, so a dial that skipped the
// ECH dialer still reaches the rig over plain TLS and gets 421, not a DNS or
// connect error. The shared control-plane transport offers h2 first, so the
// ALPN check is what pins the failover-specific http/1.1 dial.
func TestFailoverClient_RequestsOverECHWithHTTP11Only(t *testing.T) {
	var echAccepted atomic.Bool
	var alpn atomic.Value
	rig := echtest.Start(t, "localhost", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		echAccepted.Store(r.TLS != nil && r.TLS.ECHAccepted)
		if r.TLS != nil {
			alpn.Store(r.TLS.NegotiatedProtocol)
		}
		w.WriteHeader(http.StatusOK)
	}))
	_, port, err := net.SplitHostPort(rig.Addr)
	if err != nil {
		t.Fatal(err)
	}

	// Built after Start: the transport binds ech.Shared() at construction.
	fc := NewFailoverClient("https://localhost:"+port, "agent-1", "token",
		&tls.Config{RootCAs: rig.Pool, MinVersion: tls.VersionTLS12})

	resp, err := fc.client.Get("https://localhost:" + port + "/api/v1/agents/agent-1/heartbeat")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (421 = the TLS dial did not use ECH)", resp.StatusCode)
	}
	if !echAccepted.Load() {
		t.Fatal("server handshake did not accept ECH")
	}
	if resp.TLS == nil || !resp.TLS.ECHAccepted {
		t.Fatal("client connection state does not report ECH accepted")
	}
	if got := resp.TLS.NegotiatedProtocol; got != "http/1.1" {
		t.Fatalf("client ALPN = %q, want http/1.1 (failover must not offer h2)", got)
	}
	if got, _ := alpn.Load().(string); got != "http/1.1" {
		t.Fatalf("server ALPN = %q, want http/1.1", got)
	}
	if resp.ProtoMajor != 1 {
		t.Fatalf("response proto = %s, want HTTP/1.x", resp.Proto)
	}
}
