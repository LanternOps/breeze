package unifi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// The controller-facing client must refuse redirects: it sends the secret
// X-API-KEY on every request, and Go does NOT strip custom headers on a
// cross-host redirect. A controller that 3xx-redirects to an attacker host
// would otherwise both leak the key and turn the agent into an SSRF relay.
func TestDefaultHTTPClientRefusesRedirectsAndDoesNotLeakKey(t *testing.T) {
	var evilHits int32
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&evilHits, 1)
		if r.Header.Get("X-API-KEY") != "" {
			t.Errorf("X-API-KEY leaked to redirect target")
		}
		w.Write([]byte(`{"data":[]}`))
	}))
	defer evil.Close()

	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, evil.URL+r.URL.Path, http.StatusFound)
	}))
	defer controller.Close()

	c := NewAPIClient(controller.URL, "secret", DefaultHTTPClient())
	if _, err := c.Poll(context.Background()); err == nil {
		t.Fatalf("expected an error when the controller redirects, got nil")
	}
	if n := atomic.LoadInt32(&evilHits); n != 0 {
		t.Fatalf("agent followed redirect to attacker host (%d hits) — key/SSRF exposure", n)
	}
}

func TestPollParsesDevicesAndClients(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-KEY") != "k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/proxy/network/integration/v1/sites":
			w.Write([]byte(`{"data":[{"id":"s1"}]}`))
		case "/proxy/network/integration/v1/sites/s1/devices":
			w.Write([]byte(`{"data":[{"id":"d1","mac":"aa:bb","name":"AP","uptime":10,"num_clients":1}]}`))
		case "/proxy/network/integration/v1/sites/s1/clients":
			w.Write([]byte(`{"data":[{"mac":"cc:dd","hostname":"phone","ip":"10.0.0.9","is_wired":false}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := NewAPIClient(srv.URL, "k", srv.Client())
	snap, err := c.Poll(context.Background())
	if err != nil {
		t.Fatalf("Poll error: %v", err)
	}
	if !snap.FirmwareOK {
		t.Fatalf("expected FirmwareOK true")
	}
	if len(snap.Devices) != 1 || snap.Devices[0].ID != "d1" || snap.Devices[0].SiteID != "s1" {
		t.Fatalf("unexpected devices: %+v", snap.Devices)
	}
	if len(snap.Clients) != 1 || snap.Clients[0].Mac != "cc:dd" || snap.Clients[0].SiteID != "s1" {
		t.Fatalf("unexpected clients: %+v", snap.Clients)
	}
}

func TestPollFirmwareTooOld(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound) // integration API absent → treat as firmware/integration unavailable
	}))
	defer srv.Close()
	c := NewAPIClient(srv.URL, "k", srv.Client())
	snap, err := c.Poll(context.Background())
	if err != nil {
		t.Fatalf("Poll should not hard-error on missing integration: %v", err)
	}
	if snap.FirmwareOK {
		t.Fatalf("expected FirmwareOK false when integration endpoint is 404")
	}
}
