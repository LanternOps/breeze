package agentapp

import (
	"net/http"
	"testing"
	"time"
)

func TestShipperClient_UsesECHTransport(t *testing.T) {
	c := newShipperHTTPClient()
	tr, ok := c.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("Transport = %T, want *http.Transport", c.Transport)
	}
	if tr.DialTLSContext == nil {
		t.Fatal("DialTLSContext must be the ECH dialer")
	}
	if c.Timeout != 30*time.Second {
		t.Fatalf("Timeout = %v, want 30s (previous shipper default)", c.Timeout)
	}
}
