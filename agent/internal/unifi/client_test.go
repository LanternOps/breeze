package unifi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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

// Fixtures below are the REAL UniFi Network Integration API shape (camelCase),
// taken verbatim from a Network 9.x controller in issue #5087 and cross-checked
// against the published schemas for getDeviceOverviewPage /
// getConnectedClientOverviewPage. They must NOT be "simplified" back to the
// struct's own field names: the previous fixture echoed whatever the structs
// declared, so the tests passed while every field but id/name decoded empty
// against a real controller.
const (
	realDeviceListJSON = `{"data":[{"id":"217b8bfb-0000-4000-8000-000000000001",` +
		`"name":"SW i13 Main","model":"US 48 PoE 500W","state":"ONLINE",` +
		`"ipAddress":"172.16.10.2","macAddress":"44:d9:e7:1a:2b:3c",` +
		`"firmwareVersion":"7.4.1","firmwareUpdatable":false,` +
		`"features":["switching"],"interfaces":["ports"],"supported":true}]}`

	realClientListJSON = `{"data":[{"id":"0616182e-0000-4000-8000-000000000002",` +
		`"name":"PrinterDirectie-2 be:5e","type":"WIRED","access":{"type":"DEFAULT"},` +
		`"ipAddress":"172.16.10.51","macAddress":"f4:a9:97:be:5e:11",` +
		`"connectedAt":"2026-08-29T06:36:43Z",` +
		`"uplinkDeviceId":"116f5b2d-0000-4000-8000-000000000001"}]}`
)

func realControllerServer(t *testing.T, devicesJSON, clientsJSON string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-KEY") != "k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/proxy/network/integration/v1/sites":
			io.WriteString(w, `{"data":[{"id":"s1","name":"Default"}]}`)
		case "/proxy/network/integration/v1/sites/s1/devices":
			io.WriteString(w, devicesJSON)
		case "/proxy/network/integration/v1/sites/s1/clients":
			io.WriteString(w, clientsJSON)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func TestPollParsesDevicesAndClients(t *testing.T) {
	srv := realControllerServer(t, realDeviceListJSON, realClientListJSON)
	defer srv.Close()

	c := NewAPIClient(srv.URL, "k", srv.Client())
	snap, err := c.Poll(context.Background())
	if err != nil {
		t.Fatalf("Poll error: %v", err)
	}
	if !snap.FirmwareOK {
		t.Fatalf("expected FirmwareOK true")
	}

	if len(snap.Devices) != 1 {
		t.Fatalf("expected 1 device, got %d: %+v", len(snap.Devices), snap.Devices)
	}
	d := snap.Devices[0]
	if d.ID != "217b8bfb-0000-4000-8000-000000000001" {
		t.Errorf("device ID = %q, want the controller's id", d.ID)
	}
	if d.Name != "SW i13 Main" {
		t.Errorf("device Name = %q, want %q", d.Name, "SW i13 Main")
	}
	// The regression this test exists for: macAddress, not mac. An empty Mac here
	// is exactly what shipped to unifi_device_telemetry and defeated the
	// discovered_assets MAC enrichment (#5087).
	if d.Mac != "44:d9:e7:1a:2b:3c" {
		t.Errorf("device Mac = %q, want %q (decoded from macAddress)", d.Mac, "44:d9:e7:1a:2b:3c")
	}
	if d.SiteID != "s1" {
		t.Errorf("device SiteID = %q, want s1", d.SiteID)
	}
	// Raw must stay the verbatim controller element so the API can keep reading
	// fields the agent does not model (deviceIp(device.raw) server-side).
	if !strings.Contains(string(d.Raw), `"macAddress":"44:d9:e7:1a:2b:3c"`) {
		t.Errorf("device Raw did not carry the verbatim element: %s", d.Raw)
	}

	if len(snap.Clients) != 1 {
		t.Fatalf("expected 1 client, got %d: %+v", len(snap.Clients), snap.Clients)
	}
	cl := snap.Clients[0]
	if cl.Mac != "f4:a9:97:be:5e:11" {
		t.Errorf("client Mac = %q, want %q (decoded from macAddress)", cl.Mac, "f4:a9:97:be:5e:11")
	}
	if cl.Hostname != "PrinterDirectie-2 be:5e" {
		t.Errorf("client Hostname = %q, want the controller's name field", cl.Hostname)
	}
	if cl.IP != "172.16.10.51" {
		t.Errorf("client IP = %q, want %q (decoded from ipAddress)", cl.IP, "172.16.10.51")
	}
	if cl.ConnectedDeviceID != "116f5b2d-0000-4000-8000-000000000001" {
		t.Errorf("client ConnectedDeviceID = %q, want the uplinkDeviceId", cl.ConnectedDeviceID)
	}
	// The API expresses wired-ness as type:"WIRED", never an is_wired boolean.
	if !cl.IsWired() {
		t.Errorf("client IsWired = false, want true for type=WIRED")
	}
	if cl.SiteID != "s1" {
		t.Errorf("client SiteID = %q, want s1", cl.SiteID)
	}
}

// A wireless client must NOT be reported as wired. The old snake_case decode made
// every client is_wired=false by accident, so "false" alone proves nothing —
// this pins the value to the controller's type discriminator.
func TestPollClientWiredFlagFollowsTypeDiscriminator(t *testing.T) {
	clients := `{"data":[` +
		`{"id":"c-wired","name":"printer","type":"WIRED","macAddress":"f4:a9:97:00:00:01","ipAddress":"172.16.10.51"},` +
		`{"id":"c-wifi","name":"phone","type":"WIRELESS","macAddress":"f4:a9:97:00:00:02","ipAddress":"172.16.10.52"},` +
		`{"id":"c-vpn","name":"laptop-vpn","type":"VPN","macAddress":"f4:a9:97:00:00:03"},` +
		`{"id":"c-tele","name":"teleport","type":"TELEPORT","macAddress":"f4:a9:97:00:00:04"},` +
		`{"id":"c-new","name":"future-enum","type":"SOMETHING_NEW","macAddress":"f4:a9:97:00:00:05"},` +
		`{"id":"c-none","name":"no-type","macAddress":"f4:a9:97:00:00:06"}]}`
	srv := realControllerServer(t, `{"data":[]}`, clients)
	defer srv.Close()

	snap, err := NewAPIClient(srv.URL, "k", srv.Client()).Poll(context.Background())
	if err != nil {
		t.Fatalf("Poll error: %v", err)
	}
	if len(snap.Clients) != 6 {
		t.Fatalf("expected 6 clients, got %d", len(snap.Clients))
	}
	// Only WIRED is wired. An unknown or absent type degrades to not-wired rather
	// than guessing — the raw element is still uploaded, so the truth is recoverable.
	want := map[string]bool{
		"f4:a9:97:00:00:01": true,  // WIRED
		"f4:a9:97:00:00:02": false, // WIRELESS
		"f4:a9:97:00:00:03": false, // VPN
		"f4:a9:97:00:00:04": false, // TELEPORT
		"f4:a9:97:00:00:05": false, // unknown future enum
		"f4:a9:97:00:00:06": false, // type absent entirely
	}
	for _, cl := range snap.Clients {
		expected, ok := want[cl.Mac]
		if !ok {
			t.Fatalf("client decoded with unexpected Mac %q (macAddress not mapped?)", cl.Mac)
		}
		if cl.IsWired() != expected {
			t.Errorf("client %q IsWired() = %v, want %v", cl.Mac, cl.IsWired(), expected)
		}
	}
}

func TestPoll_ReportsSitesWithNames(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/sites"):
			io.WriteString(w, `{"data":[{"id":"s1","name":"HQ"},{"id":"s2","name":"Branch"}]}`)
		default:
			io.WriteString(w, `{"data":[]}`)
		}
	}))
	defer srv.Close()
	c := NewAPIClient(srv.URL, "k", srv.Client())
	snap, err := c.Poll(context.Background())
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(snap.Sites) != 2 || snap.Sites[0].ID != "s1" || snap.Sites[0].Name != "HQ" {
		t.Fatalf("got sites %+v", snap.Sites)
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

// The bug in #5087 survived because the fixture was written to mirror the STRUCT
// instead of the controller, so it agreed with whatever tags the structs happened
// to declare. This guard fails loudly if the fixtures are ever "simplified" back
// toward Breeze-side field names, instead of letting the assertions above fail in
// a way that reads like a mapping bug.
func TestFixturesSpeakTheControllerVocabulary(t *testing.T) {
	for _, fixture := range []struct{ name, body string }{
		{"devices", realDeviceListJSON},
		{"clients", realClientListJSON},
	} {
		for _, required := range []string{`"macAddress"`} {
			if !strings.Contains(fixture.body, required) {
				t.Errorf("%s fixture lost %s — it must stay the real controller shape", fixture.name, required)
			}
		}
		// Breeze-side / invented spellings that the controller never sends.
		for _, forbidden := range []string{`"mac"`, `"hostname"`, `"is_wired"`, `"connected_device_id"`, `"uptime_seconds"`, `"num_clients"`} {
			if strings.Contains(fixture.body, forbidden) {
				t.Errorf("%s fixture contains %s, which the Integration API never sends — "+
					"the fixture must not be rewritten to match our structs (that is what hid #5087)", fixture.name, forbidden)
			}
		}
	}
	if !strings.Contains(realClientListJSON, `"ipAddress"`) || !strings.Contains(realClientListJSON, `"uplinkDeviceId"`) {
		t.Error("client fixture must keep ipAddress/uplinkDeviceId — the fields #5087 was about")
	}
}
