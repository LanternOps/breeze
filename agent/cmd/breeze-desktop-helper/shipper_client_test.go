package main

import (
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ech/echtest"
)

// This process ships its logs to the control plane. Without an injected
// client the shipper falls back to a bare http.Client, whose TLS cannot get
// past an SNI filter (#8869). The rig answers 421 unless ECH was accepted.
func TestNewShipperHTTPClient_DialsTLSThroughECH(t *testing.T) {
	rig := echtest.Start(t, "control.echtest.invalid", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	c := newShipperHTTPClient()
	tr, ok := c.Transport.(*http.Transport)
	if !ok || tr.TLSClientConfig == nil {
		t.Fatalf("Transport = %T, want *http.Transport with a TLS config", c.Transport)
	}
	tr.TLSClientConfig.RootCAs = rig.Pool
	resp, err := c.Get(rig.URL("/api/v1/agents/a1/logs"))
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (421 = TLS dial did not use ECH)", resp.StatusCode)
	}
	if c.Timeout != 30*time.Second {
		t.Fatalf("Timeout = %v, want 30s (the shipper's previous default)", c.Timeout)
	}
}
