package websocket

import (
	"testing"
	"time"
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
