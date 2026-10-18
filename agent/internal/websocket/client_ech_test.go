package websocket

import (
	"crypto/tls"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ech/echtest"
	"github.com/breeze-rmm/agent/internal/secmem"
)

func TestWSDialer_UsesNetDialTLSContext(t *testing.T) {
	c := newTestClient("https://example.invalid", echoHandler)
	d := c.newDialer()
	if d.NetDialTLSContext == nil {
		t.Fatal("NetDialTLSContext must be set so the handshake goes through the ECH dialer")
	}
	if d.NetDialContext == nil {
		t.Fatal("NetDialContext must stay set (netcache + proxied dials)")
	}
	if d.HandshakeTimeout != 10*time.Second {
		t.Fatalf("HandshakeTimeout = %v, want 10s", d.HandshakeTimeout)
	}
}

// End to end: the agent WebSocket upgrade completes against a server that
// answers 421 to any request whose handshake did not accept ECH. The client
// URL carries the rig's real port, so a dial that skipped the ECH dialer still
// reaches the rig over plain TLS and fails with a bad handshake (421) rather
// than a DNS or connect error.
func TestWSConnect_UpgradesOverECHEndToEnd(t *testing.T) {
	var echAccepted, upgraded atomic.Bool
	var innerSNI atomic.Value
	done := make(chan struct{})
	defer close(done)
	// The upgrader writes the 101 before the handler can record the upgrade,
	// so the client's connect() may return first; the handler signals here
	// once its bookkeeping is done (#9005).
	handlerReady := make(chan struct{})
	rig := echtest.Start(t, "localhost", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		echAccepted.Store(r.TLS != nil && r.TLS.ECHAccepted)
		if r.TLS != nil {
			innerSNI.Store(r.TLS.ServerName)
		}
		conn, err := testUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		upgraded.Store(true)
		close(handlerReady)
		defer func() { _ = conn.Close() }()
		<-done
	}))
	_, port, err := net.SplitHostPort(rig.Addr)
	if err != nil {
		t.Fatal(err)
	}

	// Built after Start: newDialer binds ech.Shared() per connect, and the rig
	// has already installed its dialer with localhost in ECH mode.
	c := New(&Config{
		ServerURL: "https://localhost:" + port,
		AgentID:   "test-agent-001",
		AuthToken: secmem.NewSecureString("brz_test_token"),
		TLSConfig: &tls.Config{RootCAs: rig.Pool, MinVersion: tls.VersionTLS12},
	}, noopHandler)
	if err := c.connect(); err != nil {
		t.Fatalf("connect: %v (bad handshake / 421 = the TLS dial did not go through the ECH dialer)", err)
	}
	defer c.closeCurrentConn(false)

	if !c.IsConnected() {
		t.Fatal("client does not report connected after a successful connect")
	}
	select {
	case <-handlerReady:
	case <-time.After(5 * time.Second):
		t.Fatal("server handler did not finish the upgrade bookkeeping within 5s")
	}
	if !echAccepted.Load() {
		t.Fatal("server handshake did not accept ECH")
	}
	if !upgraded.Load() {
		t.Fatal("server never completed the WebSocket upgrade")
	}
	if got, _ := innerSNI.Load().(string); got != "localhost" {
		t.Fatalf("inner SNI = %q, want localhost", got)
	}
}
