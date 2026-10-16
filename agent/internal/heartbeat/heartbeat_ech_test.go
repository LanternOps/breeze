package heartbeat

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	gwebsocket "github.com/gorilla/websocket"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ech"
	"github.com/breeze-rmm/agent/internal/health"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/websocket"
)

// swapSharedECHDialer isolates the process-wide ECH dialer for one test so a
// kill-switch flip cannot leak into later tests in the package.
func swapSharedECHDialer(t *testing.T) *ech.Dialer {
	t.Helper()
	d := ech.New(ech.Options{LocalEnabled: true, ServerEnabled: true})
	t.Cleanup(ech.SetSharedForTest(d))
	return d
}

func TestNewHeartbeatHTTPClient_UsesECHTransport(t *testing.T) {
	c := newHeartbeatHTTPClient(nil)
	tr, ok := c.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("Transport = %T, want *http.Transport", c.Transport)
	}
	if tr.DialTLSContext == nil {
		t.Fatal("DialTLSContext is nil: heartbeat TLS does not go through the ECH dialer")
	}
	if tr.DialContext == nil {
		t.Fatal("DialContext is nil: heartbeat TCP does not go through the DNS-caching dialer")
	}
	if tr.Proxy == nil {
		t.Fatal("Proxy is nil: DefaultTransport clone semantics lost (proxied agents stranded)")
	}
	if c.Timeout != 30*time.Second {
		t.Fatalf("client Timeout = %v, want 30s", c.Timeout)
	}
}

func TestDecideECHEnabledUpdate(t *testing.T) {
	cases := []struct {
		name        string
		raw         any
		current     bool
		wantValue   bool
		wantChanged bool
		wantOK      bool
	}{
		{"bool false from true", false, true, false, true, true},
		{"string false from true", "false", true, false, true, true},
		{"bool true from true is unchanged", true, true, true, false, true},
		{"string true from false", "true", false, true, true, true},
		{"unrecognized string rejected", "yes", true, false, false, false},
		{"nil rejected", nil, true, false, false, false},
		{"number rejected", 0, true, false, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			value, changed, ok := decideECHEnabledUpdate(tc.raw, tc.current)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if !ok {
				return
			}
			if value != tc.wantValue || changed != tc.wantChanged {
				t.Fatalf("decideECHEnabledUpdate(%v, %v) = (%v, %v), want (%v, %v)",
					tc.raw, tc.current, value, changed, tc.wantValue, tc.wantChanged)
			}
		})
	}
}

func TestApplyConfigUpdate_ECHEnabledFalsePersistsAndSetsDialer(t *testing.T) {
	for _, key := range []string{"ech_enabled", "echEnabled"} {
		t.Run(key, func(t *testing.T) {
			cfg := swapTestConfig(t, "https://primary.example.com", "")
			if !cfg.ECHServerEnabled {
				t.Fatal("precondition: ECHServerEnabled should default to true")
			}
			swapSharedECHDialer(t)
			h := &Heartbeat{config: cfg}

			h.applyConfigUpdate(map[string]any{key: false})

			if h.config.ECHServerEnabled {
				t.Fatal("ECHServerEnabled still true in memory after kill switch")
			}
			if ech.SharedEnabledForTest() {
				t.Fatal("shared ECH dialer still enabled after kill switch")
			}
			reloaded, err := config.Reload()
			if err != nil {
				t.Fatalf("Reload: %v", err)
			}
			if reloaded.ECHServerEnabled {
				t.Fatal("ech_server_enabled=false did not survive a config reload")
			}

			// And the switch turns back on.
			h.applyConfigUpdate(map[string]any{key: "true"})
			if !h.config.ECHServerEnabled || !ech.SharedEnabledForTest() {
				t.Fatal("re-enabling via \"true\" did not restore ECH")
			}
		})
	}
}

// Review Focus 4: the kill switch affects only subsequent dials; it must not
// tear down the live WebSocket.
func TestApplyConfigUpdate_ECHEnabledFalseDoesNotForceReconnect(t *testing.T) {
	var upgrades atomic.Int32
	upgrader := gwebsocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		upgrades.Add(1)
		defer func() { _ = conn.Close() }()
		_ = conn.WriteJSON(map[string]any{"type": "connected"})
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer srv.Close()

	cfg := swapTestConfig(t, srv.URL, "")
	swapSharedECHDialer(t)
	h := &Heartbeat{config: cfg}
	ws := websocket.New(&websocket.Config{ServerURL: srv.URL, AgentID: "a", AuthToken: secmem.NewSecureString("t")}, nil)
	h.SetWebSocketClient(ws)
	go ws.Start()
	defer ws.Stop()

	deadline := time.Now().Add(5 * time.Second)
	for !ws.IsConnected() {
		if time.Now().After(deadline) {
			t.Fatal("websocket never connected")
		}
		time.Sleep(10 * time.Millisecond)
	}

	h.applyConfigUpdate(map[string]any{"ech_enabled": false})

	if !ws.IsConnected() {
		t.Fatal("kill switch closed the live websocket connection")
	}
	time.Sleep(200 * time.Millisecond)
	if !ws.IsConnected() {
		t.Fatal("websocket disconnected after the kill switch")
	}
	if n := upgrades.Load(); n != 1 {
		t.Fatalf("websocket upgrades = %d, want 1 (kill switch must not force a reconnect)", n)
	}
	if h.config.ECHServerEnabled {
		t.Fatal("setup: kill switch was not applied")
	}
}

func TestApplyConfigUpdate_ECHEnabledAbsentIsNoop(t *testing.T) {
	cfg := swapTestConfig(t, "https://primary.example.com", "")
	if !cfg.ECHServerEnabled {
		t.Fatal("precondition: ECHServerEnabled should default to true")
	}
	swapSharedECHDialer(t)
	h := &Heartbeat{config: cfg}

	h.applyConfigUpdate(map[string]any{"backup_server_url": ""})

	if !h.config.ECHServerEnabled {
		t.Fatal("absent ech_enabled changed ECHServerEnabled in memory")
	}
	if !ech.SharedEnabledForTest() {
		t.Fatal("absent ech_enabled disabled the shared dialer")
	}
	reloaded, err := config.Reload()
	if err != nil {
		t.Fatalf("Reload: %v", err)
	}
	if !reloaded.ECHServerEnabled {
		t.Fatal("absent ech_enabled persisted ech_server_enabled=false")
	}
}

func TestControlPlaneComponent_Table(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name        string
		st          ech.HostStatus
		wantStatus  health.Status
		wantMessage string
	}{
		{"ech active", ech.HostStatus{Mode: ech.ModeECH, ECHActive: true, FilterSignatureSeenAt: now},
			health.Healthy, "reachable via encrypted client hello"},
		{"recent signature, not ech", ech.HostStatus{Mode: ech.ModePlain, FilterSignatureSeenAt: now.Add(-time.Minute)},
			health.Degraded, "control plane blocked by a network security filter (plaintext HTTP answered on the TLS port)"},
		{"cooldown", ech.HostStatus{Mode: ech.ModeCooldown, InCooldown: true, FilterSignatureSeenAt: now.Add(-time.Hour)},
			health.Degraded, "encrypted client hello unavailable; retrying later"},
		// Another client on the same host exhausted ECH while the heartbeat
		// still holds a live ECH connection: the next reconnect is stranded
		// for the cooldown, so the warning must not be hidden by the live wire.
		{"ech active, cooldown", ech.HostStatus{Mode: ech.ModeCooldown, ECHActive: true, InCooldown: true, FilterSignatureSeenAt: now.Add(-time.Minute)},
			health.Degraded, "encrypted client hello unavailable; retrying later"},
		// Kill switch on a live ECH connection (#8869 lab): the wire is still
		// ECH, so this is not a filter block; the next reconnect dials plain.
		{"ech active, server switch off", ech.HostStatus{Mode: ech.ModeECH, ECHActive: true, Disabled: ech.DisabledByServer, FilterSignatureSeenAt: now.Add(-time.Minute)},
			health.Degraded, "encrypted client hello disabled by control plane; the next reconnect dials plain"},
		{"ech active, local opt-out", ech.HostStatus{Mode: ech.ModeECH, ECHActive: true, Disabled: ech.DisabledByConfig, FilterSignatureSeenAt: now.Add(-time.Minute)},
			health.Degraded, "encrypted client hello disabled by configuration; the next reconnect dials plain"},
		// Switch off and the wire is plain: the switch alone is not news.
		{"switch off, not ech active", ech.HostStatus{Disabled: ech.DisabledByServer}, health.Healthy, ""},
		{"plain, nothing seen", ech.HostStatus{}, health.Healthy, ""},
		{"plain, stale signature", ech.HostStatus{FilterSignatureSeenAt: now.Add(-11 * time.Minute)}, health.Healthy, ""},
		// A plain handshake after the signature means the host is reachable:
		// the signature is stale even inside the 10-minute window.
		{"plain success after signature", ech.HostStatus{
			FilterSignatureSeenAt: now.Add(-time.Minute),
			LastPlainSuccessAt:    now.Add(-time.Minute + time.Second),
		}, health.Healthy, ""},
		{"signature after plain success", ech.HostStatus{
			FilterSignatureSeenAt: now.Add(-time.Minute + time.Second),
			LastPlainSuccessAt:    now.Add(-time.Minute),
		}, health.Degraded, "control plane blocked by a network security filter (plaintext HTTP answered on the TLS port)"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, message := controlPlaneComponent(tc.st)
			if status != tc.wantStatus || message != tc.wantMessage {
				t.Fatalf("controlPlaneComponent(%+v) = (%q, %q), want (%q, %q)",
					tc.st, status, message, tc.wantStatus, tc.wantMessage)
			}
		})
	}
}

// filterSignatureSeenAt is sent only while the signature is newer than the
// last plain success; a reachable host must not report a stale filter.
func TestSetECHStatus_SignatureOnlyWhenNewerThanPlainSuccess(t *testing.T) {
	sig := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name    string
		st      ech.HostStatus
		wantSig string
	}{
		{"no signature", ech.HostStatus{LastPlainSuccessAt: sig}, ""},
		{"signature, never a plain success", ech.HostStatus{FilterSignatureSeenAt: sig}, "2026-10-16T12:00:00Z"},
		{"plain success after signature", ech.HostStatus{FilterSignatureSeenAt: sig, LastPlainSuccessAt: sig.Add(time.Second)}, ""},
		{"signature after plain success", ech.HostStatus{FilterSignatureSeenAt: sig.Add(time.Second), LastPlainSuccessAt: sig}, "2026-10-16T12:00:01Z"},
		{"ech active, signature older than window", ech.HostStatus{Mode: ech.ModeECH, ECHActive: true, FilterSignatureSeenAt: sig.Add(-time.Hour)}, "2026-10-16T11:00:00Z"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var p HeartbeatPayload
			p.setECHStatus(tc.st)
			if p.FilterSignatureSeenAt != tc.wantSig {
				t.Fatalf("FilterSignatureSeenAt = %q, want %q", p.FilterSignatureSeenAt, tc.wantSig)
			}
			raw, err := json.Marshal(p)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			var m map[string]any
			if err := json.Unmarshal(raw, &m); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if _, present := m["filterSignatureSeenAt"]; present != (tc.wantSig != "") {
				t.Fatalf("filterSignatureSeenAt present = %v, want %v (%s)", present, tc.wantSig != "", raw)
			}
		})
	}
}

// Review Focus 5: control_plane rides the v1 health wire shape the API's
// strict agentHealthComponentSchema accepts.
func TestHeartbeatPayload_ControlPlaneComponentIsV1Shape(t *testing.T) {
	now := time.Now()
	rows := []ech.HostStatus{
		{Mode: ech.ModeECH, ECHActive: true},
		{Mode: ech.ModeECH, ECHActive: true, Disabled: ech.DisabledByServer},
		{FilterSignatureSeenAt: now},
		{Mode: ech.ModeCooldown, InCooldown: true},
		{},
	}
	allowed := map[string]bool{"healthy": true, "warning": true, "error": true, "unknown": true}
	for i, st := range rows {
		mon := health.NewMonitor()
		status, message := controlPlaneComponent(st)
		mon.Update(controlPlaneComponentName, status, message)
		snap := mon.Snapshot(health.SnapshotMetadata{AgentVersion: "1.0.0", ObservedAt: now})
		raw, err := json.Marshal(HeartbeatPayload{Status: "ok", HealthStatus: &snap})
		if err != nil {
			t.Fatalf("row %d: marshal: %v", i, err)
		}
		var doc struct {
			HealthStatus struct {
				Components map[string]map[string]any `json:"components"`
			} `json:"healthStatus"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			t.Fatalf("row %d: unmarshal: %v", i, err)
		}
		comp, ok := doc.HealthStatus.Components["control_plane"]
		if !ok {
			t.Fatalf("row %d: components.control_plane missing: %s", i, raw)
		}
		for k := range comp {
			if k != "state" && k != "reason" {
				t.Fatalf("row %d: unexpected key %q in control_plane component: %v", i, k, comp)
			}
		}
		state, _ := comp["state"].(string)
		if !allowed[state] {
			t.Fatalf("row %d: state %q not a v1 wire state", i, state)
		}
		reason, hasReason := comp["reason"]
		if message == "" && hasReason {
			t.Fatalf("row %d: empty message must omit reason, got %v", i, reason)
		}
		if message != "" && reason != message {
			t.Fatalf("row %d: reason = %v, want %q", i, reason, message)
		}
		if status == health.Degraded && state != "warning" {
			t.Fatalf("row %d: degraded mapped to %q, want warning", i, state)
		}
	}
}

func TestSendHeartbeat_PayloadCarriesECHFields(t *testing.T) {
	var (
		mu     sync.Mutex
		bodies [][]byte
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, b)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"commands":[]}`))
	}))
	defer srv.Close()

	d := swapSharedECHDialer(t)
	cfg := &config.Config{AgentID: "agent-1", ServerURL: srv.URL, AuthToken: "test-token"}
	h := newRecoveryMarkerTestHeartbeat(cfg)

	// Same sequence sendHeartbeat runs: observe before Snapshot, set the
	// payload fields after building the payload, then post.
	beat := func() map[string]any {
		t.Helper()
		st := h.observeControlPlane()
		snap := h.healthMon.Snapshot(health.SnapshotMetadata{AgentVersion: "1.0.0", ObservedAt: time.Now().UTC()})
		payload := HeartbeatPayload{Status: "ok", AgentVersion: "1.0.0", HealthStatus: &snap}
		payload.setECHStatus(st)
		if !h.postHeartbeat(srv.URL, &payload) {
			t.Fatal("postHeartbeat failed")
		}
		mu.Lock()
		raw := bodies[len(bodies)-1]
		mu.Unlock()
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("unmarshal request body: %v", err)
		}
		return m
	}

	// Never-dialed host: both fields omitted, component healthy.
	m := beat()
	if _, ok := m["echActive"]; ok {
		t.Fatalf("echActive present for a plain host: %v", m["echActive"])
	}
	if _, ok := m["filterSignatureSeenAt"]; ok {
		t.Fatalf("filterSignatureSeenAt present with no signature: %v", m["filterSignatureSeenAt"])
	}

	seen := time.Now().Add(-time.Minute)
	d.ForceModeForTest("127.0.0.1", ech.ModeECH, seen)
	// echActive is wire truth: ech mode alone is not enough.
	m = beat()
	if _, ok := m["echActive"]; ok {
		t.Fatalf("echActive present in ech mode before any accepted ECH dial: %v", m["echActive"])
	}
	d.NoteECHAcceptedForTest("127.0.0.1", time.Now())
	m = beat()
	if m["echActive"] != true {
		t.Fatalf(`request JSON echActive = %v, want true`, m["echActive"])
	}
	s, _ := m["filterSignatureSeenAt"].(string)
	got, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("filterSignatureSeenAt %q is not RFC 3339: %v", s, err)
	}
	if !got.Equal(seen.UTC().Truncate(time.Second)) || got.Location() != time.UTC {
		t.Fatalf("filterSignatureSeenAt = %v, want %v in UTC", got, seen.UTC().Truncate(time.Second))
	}
	comps := m["healthStatus"].(map[string]any)["components"].(map[string]any)
	cp, ok := comps["control_plane"].(map[string]any)
	if !ok {
		t.Fatalf("components.control_plane missing: %v", comps)
	}
	if cp["state"] != "healthy" || cp["reason"] != "reachable via encrypted client hello" {
		t.Fatalf("control_plane component = %v", cp)
	}

	// Kill switch on the live ECH connection (#8869 lab): the wire is still
	// ECH, so echActive stays true and health says the next reconnect is
	// plain, not that a filter blocks the control plane.
	// (applyConfigUpdate → SetServerEnabled is covered by
	// TestApplyConfigUpdate_ECHEnabledFalsePersistsAndSetsDialer.)
	d.SetServerEnabled(false)
	m = beat()
	if m["echActive"] != true {
		t.Fatalf(`kill switch on live ECH: echActive = %v, want true`, m["echActive"])
	}
	cp = m["healthStatus"].(map[string]any)["components"].(map[string]any)["control_plane"].(map[string]any)
	if cp["state"] != "warning" || cp["reason"] != "encrypted client hello disabled by control plane; the next reconnect dials plain" {
		t.Fatalf("kill switch on live ECH: control_plane component = %v", cp)
	}
}

// Monitor.Update warn-logs every non-healthy call, so the component is only
// re-recorded when (status, message) changes between beats.
func TestObserveControlPlane_UpdatesComponentOnlyOnChange(t *testing.T) {
	d := swapSharedECHDialer(t)
	cfg := &config.Config{AgentID: "agent-1", ServerURL: "https://cp.example.com"}
	h := &Heartbeat{config: cfg, healthMon: health.NewMonitor()}

	h.observeControlPlane()
	c, ok := h.healthMon.Get(controlPlaneComponentName)
	if !ok || c.Status != health.Healthy {
		t.Fatalf("first beat: component = %+v (present=%v), want healthy", c, ok)
	}

	// Unchanged ECH state must not re-Update the component.
	h.healthMon.Update(controlPlaneComponentName, health.Unhealthy, "sentinel")
	h.observeControlPlane()
	if c, _ := h.healthMon.Get(controlPlaneComponentName); c.Status != health.Unhealthy || c.Message != "sentinel" {
		t.Fatalf("unchanged state re-updated the component: %+v", c)
	}

	// A change does.
	d.ForceModeForTest("cp.example.com", ech.ModeCooldown, time.Time{})
	h.observeControlPlane()
	c, _ = h.healthMon.Get(controlPlaneComponentName)
	if c.Status != health.Degraded || c.Message != "encrypted client hello unavailable; retrying later" {
		t.Fatalf("changed state: component = %+v, want degraded cooldown", c)
	}
}

func TestServerHostForECH(t *testing.T) {
	for raw, want := range map[string]string{
		"https://cp.example.com":       "cp.example.com",
		"https://cp.example.com:8443/": "cp.example.com",
		"http://127.0.0.1:1234":        "127.0.0.1",
		"://bad":                       "",
		"":                             "",
	} {
		if got := serverHost(raw); got != want {
			t.Errorf("serverHost(%q) = %q, want %q", raw, got, want)
		}
	}
}
