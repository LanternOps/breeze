package heartbeat

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/isolation"
)

const containmentID = "10000000-0000-4000-8000-000000000001"

func containmentPayload(now time.Time) map[string]any {
	return map[string]any{"actionType": "network_isolation", "breakGlassSecret": base64.StdEncoding.EncodeToString(make([]byte, 32)), "parameters": map[string]any{
		"isolationId": containmentID, "generation": float64(1), "expiresAt": now.Add(time.Hour).Format(time.RFC3339Nano), "deadManSeconds": 0, "remoteRelay": false,
		"allow": []any{map[string]any{"kind": "host", "host": "control.example.test", "proto": "tcp", "ports": []any{float64(443)}, "scope": "breeze"}},
	}}
}

func TestContainmentPayloadValidation(t *testing.T) {
	now := time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		name   string
		change func(map[string]any, map[string]any, map[string]any)
		valid  bool
	}{
		{"valid", func(p, q, e map[string]any) {}, true},
		{"uuid", func(p, q, e map[string]any) { q["isolationId"] = "bad" }, false},
		{"generation zero", func(p, q, e map[string]any) { q["generation"] = 0 }, false},
		{"generation fraction", func(p, q, e map[string]any) { q["generation"] = 1.5 }, false},
		{"generation string", func(p, q, e map[string]any) { q["generation"] = "1" }, false},
		{"expiry now", func(p, q, e map[string]any) { q["expiresAt"] = now.Format(time.RFC3339Nano) }, false},
		{"expiry past", func(p, q, e map[string]any) { q["expiresAt"] = now.Add(-time.Second).Format(time.RFC3339Nano) }, false},
		{"expiry ceiling", func(p, q, e map[string]any) { q["expiresAt"] = now.Add(720 * time.Hour).Format(time.RFC3339Nano) }, true},
		{"expiry within clock-skew slack", func(p, q, e map[string]any) {
			q["expiresAt"] = now.Add(720*time.Hour + containmentExpirySlack).Format(time.RFC3339Nano)
		}, true},
		{"expiry beyond ceiling", func(p, q, e map[string]any) {
			q["expiresAt"] = now.Add(720*time.Hour + containmentExpirySlack + time.Nanosecond).Format(time.RFC3339Nano)
		}, false},
		{"expiry malformed", func(p, q, e map[string]any) { q["expiresAt"] = "bad" }, false},
		{"empty allow", func(p, q, e map[string]any) { q["allow"] = []any{} }, false},
		{"wrong host", func(p, q, e map[string]any) { e["host"] = "relay.example.test" }, false},
		{"wrong port", func(p, q, e map[string]any) { e["ports"] = []any{80} }, false},
		{"merged ports", func(p, q, e map[string]any) { e["ports"] = []any{80, 443} }, true},
		{"udp only", func(p, q, e map[string]any) { e["proto"] = "udp" }, false},
		{"both protocols", func(p, q, e map[string]any) { e["proto"] = "udp+tcp" }, true},
		{"not breeze", func(p, q, e map[string]any) { e["scope"] = "any"; q["policyRevision"] = 1 }, false},
		{"secret absent", func(p, q, e map[string]any) { delete(p, "breakGlassSecret") }, false},
		{"secret short", func(p, q, e map[string]any) {
			p["breakGlassSecret"] = base64.StdEncoding.EncodeToString(make([]byte, 31))
		}, false},
		{"secret unpadded", func(p, q, e map[string]any) {
			p["breakGlassSecret"] = base64.RawStdEncoding.EncodeToString(make([]byte, 32))
		}, false},
		{"secret newline", func(p, q, e map[string]any) { p["breakGlassSecret"] = p["breakGlassSecret"].(string) + "\n" }, false},
		{"nil parameters", func(p, q, e map[string]any) { p["parameters"] = nil }, false},
		{"bad port", func(p, q, e map[string]any) { e["ports"] = []any{65536, 443} }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := containmentPayload(now)
			q := p["parameters"].(map[string]any)
			e := q["allow"].([]any)[0].(map[string]any)
			tc.change(p, q, e)
			if got := validateContainmentPayload(p, "https://CONTROL.example.test/", now); (got == nil) != tc.valid {
				t.Fatalf("validation success = %v, want %v", got == nil, tc.valid)
			}
		})
	}
	for _, revision := range []any{nil, "", "  ", 0, -1, 1.5, true, "revision-1", float64(1), 1, json.Number("1")} {
		p := containmentPayload(now)
		q := p["parameters"].(map[string]any)
		q["allow"] = append(q["allow"].([]any), map[string]any{"kind": "host", "host": "relay.example.test", "proto": "tcp", "ports": []any{443}, "scope": "any"})
		q["policyRevision"] = revision
		want := revision == "revision-1" || revision == float64(1) || revision == 1 || revision == json.Number("1")
		if got := validateContainmentPayload(p, "https://control.example.test", now); (got == nil) != want {
			t.Errorf("policy revision %v: valid=%v want=%v", revision, got == nil, want)
		}
	}
	if validateContainmentPayload(nil, "https://control.example.test", now) == nil {
		t.Fatal("nil payload accepted")
	}
}

func TestContainmentControlPlaneValidation(t *testing.T) {
	cases := []struct {
		server, host, cidr, proto string
		ports                     []uint16
		valid                     bool
	}{
		{"http://control.example.test", "control.example.test", "", "tcp", []uint16{80}, true},
		{"https://control.example.test:8443/", "CONTROL.example.test", "", "tcp", []uint16{443, 8443}, true},
		{"https://control.example.test:8443/", "control.example.test", "", "tcp", []uint16{443}, false},
		{"https://192.0.2.1", "", "192.0.2.1/32", "tcp", []uint16{443}, true},
		{"https://192.0.2.1", "", "192.0.2.0/24", "tcp", []uint16{443}, false},
		{"https://192.0.2.1", "192.0.2.1", "", "tcp", []uint16{443}, false},
		{"https://[2001:db8::1]", "", "2001:db8::1/128", "tcp", []uint16{443}, true},
		{"https://[2001:db8::1]", "", "2001:db8::/32", "tcp", []uint16{443}, false},
		{"https://control.example.test:0", "control.example.test", "", "tcp", []uint16{443}, false},
		{"ftp://control.example.test", "control.example.test", "", "tcp", []uint16{443}, false},
		{"bad", "control.example.test", "", "tcp", []uint16{443}, false},
	}
	for _, tc := range cases {
		t.Run(tc.server+tc.cidr, func(t *testing.T) {
			kind := "host"
			if tc.cidr != "" {
				kind = "cidr"
			}
			allow := []isolation.AllowEntry{{Kind: kind, Host: tc.host, CIDR: tc.cidr, Proto: tc.proto, Ports: tc.ports, Scope: "breeze"}}
			if err := validateContainmentAllow(allow, tc.server, false); (err == nil) != tc.valid {
				t.Fatalf("valid=%v want=%v", err == nil, tc.valid)
			}
		})
	}
}

func TestContainmentWireCapabilitiesAndAbsentReport(t *testing.T) {
	c := compiledSecurityCapabilities()
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	_ = json.Unmarshal(b, &fields)
	if fields["networkIsolationVersion"] != float64(0) || fields["networkIsolationReady"] != false {
		t.Fatal("unsupported capabilities must be explicit")
	}
	if _, ok := fields["networkIsolationMechanism"]; ok {
		t.Fatal("empty mechanism must be omitted")
	}
	h := &Heartbeat{containment: &containmentRuntime{manager: isolation.NewManager(isolation.ManagerDeps{DataDir: t.TempDir()})}}
	b, err = json.Marshal(h.containmentReport())
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"networkIsolation":{"journalSeq":0,"phase":"none"}}` {
		t.Fatalf("report=%s", b)
	}
	for _, raw := range []string{`{}`, `{"containment":{"networkIsolation":null}}`} {
		var response HeartbeatResponse
		if err = json.Unmarshal([]byte(raw), &response); err != nil {
			t.Fatal(err)
		}
		h.reconcileContainment(response.Containment)
		if h.containment.manager.Active() {
			t.Fatal("empty response activated isolation")
		}
	}
}

func TestContainmentVerifierUsesHeartbeatTransport(t *testing.T) {
	var requests, proxies atomic.Int32
	finished := make(chan struct{})
	tr := &http.Transport{
		TLSClientConfig: &tls.Config{ServerName: "control.example.test", MinVersion: tls.VersionTLS12},
		Proxy:           func(*http.Request) (*url.URL, error) { proxies.Add(1); return nil, nil },
		DialContext: func(context.Context, string, string) (net.Conn, error) {
			client, server := net.Pipe()
			go func() {
				defer close(finished)
				defer func() { _ = server.Close() }()
				req, err := http.ReadRequest(bufio.NewReader(server))
				if err != nil {
					t.Error("cannot read verify request")
					return
				}
				defer func() { _ = req.Body.Close() }()
				body, _ := io.ReadAll(req.Body)
				if req.Method != http.MethodPost || req.URL.Path != "/api/v1/agents/agent-id/isolation/"+containmentID+"/verify" || req.Header.Get("Authorization") != "Bearer test-token" || string(body) != "{}" {
					t.Error("wrong verify request")
				}
				requests.Add(1)
				_, _ = fmt.Fprintf(server, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nDate: %s\r\n\r\n{}", time.Now().UTC().Format(http.TimeFormat))
			}()
			return client, nil
		},
	}
	h := &Heartbeat{config: &config.Config{ServerURL: "http://control.example.test", AgentID: "agent-id", AuthToken: "test-token"}, client: &http.Client{Transport: tr}}
	cfg := h.containmentVerifierConfig()
	if cfg.TLSConfig == tr.TLSClientConfig || cfg.TLSConfig.ServerName != tr.TLSClientConfig.ServerName || cfg.TLSConfig.MinVersion != tls.VersionTLS12 {
		t.Fatal("TLS configuration was not cloned")
	}
	if _, err := isolation.NewHTTPVerifier(cfg)(context.Background(), containmentID); err != nil {
		t.Fatal(err)
	}
	<-finished
	if requests.Load() != 1 || proxies.Load() != 1 {
		t.Fatal("heartbeat dialer or proxy not used")
	}
}

func TestContainmentDesiredValidation(t *testing.T) {
	now := time.Now()
	p := containmentPayload(now)
	b, _ := json.Marshal(p["parameters"])
	var spec isolation.Spec
	_ = json.Unmarshal(b, &spec)
	for _, tc := range []struct {
		name   string
		change func(*isolation.Desired)
		valid  bool
	}{
		{"isolated", func(d *isolation.Desired) {}, true},
		{"foreign control", func(d *isolation.Desired) { d.Allow[0].Host = "relay.example.test" }, false},
		{"any scope", func(d *isolation.Desired) {
			d.Allow = append(d.Allow, isolation.AllowEntry{Kind: "host", Host: "relay.example.test", Proto: "tcp", Ports: []uint16{443}, Scope: "any"})
		}, false},
		{"expired", func(d *isolation.Desired) { d.ExpiresAt = now }, false},
		{"release", func(d *isolation.Desired) { d.Desired = "released"; d.Allow = nil; d.ExpiresAt = now }, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := isolation.Desired{Spec: spec, Desired: "isolated"}
			d.Allow = append([]isolation.AllowEntry(nil), spec.Allow...)
			tc.change(&d)
			if err := validateContainmentDesired(&d, "https://control.example.test", now); (err == nil) != tc.valid {
				t.Fatalf("valid=%v want=%v", err == nil, tc.valid)
			}
		})
	}
	// A nil manager report (rules may still be installed) must omit the block,
	// never claim the absent {phase:"none"} form the server uses to confirm a
	// release tombstone.
	f := &containmentFake{}
	h := &Heartbeat{containment: &containmentRuntime{manager: f}}
	if r := h.containmentReport(); r != nil {
		t.Fatal("nil manager report must omit the containment block")
	}
	if r := (&Heartbeat{}).containmentReport(); r != nil {
		t.Fatal("no containment runtime must omit the containment block")
	}
	if strings.Contains(string(b), "breakGlassSecret") {
		t.Fatal("unexpected secret in fixture parameters")
	}
}
