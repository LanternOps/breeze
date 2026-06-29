package unifi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

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
