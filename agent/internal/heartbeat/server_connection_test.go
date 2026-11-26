package heartbeat

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/health"
	"github.com/breeze-rmm/agent/internal/logging"
)

func serverConnectionComponent(t *testing.T, h *Heartbeat) health.AgentHealthComponent {
	t.Helper()
	snap := h.healthMon.Snapshot(health.SnapshotMetadata{AgentVersion: "1.0.0", ObservedAt: time.Now()})
	c, ok := snap.Components[serverConnectionComponentName]
	if !ok {
		t.Fatalf("snapshot has no %q component: %+v", serverConnectionComponentName, snap.Components)
	}
	return c
}

func TestObserveServerConnection_ReportsPlaintextRemoteServer(t *testing.T) {
	cases := []struct {
		name       string
		serverURL  string
		wantState  health.AgentHealthState
		wantReason string
	}{
		{"https public host", "https://rmm.example.com", health.AgentHealthHealthy, ""},
		{"http public host", "http://rmm.example.com:3001", health.AgentHealthWarning, serverConnectionPlaintextReason},
		{"http private LAN host", "http://192.168.1.20:3001", health.AgentHealthWarning, serverConnectionPlaintextReason},
		{"http localhost", "http://localhost:3001", health.AgentHealthHealthy, ""},
		{"http IPv6 loopback", "http://[::1]:3001", health.AgentHealthHealthy, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := &Heartbeat{config: &config.Config{AgentID: "agent-1", ServerURL: tc.serverURL}, healthMon: health.NewMonitor()}
			h.observeServerConnection()
			c := serverConnectionComponent(t, h)
			if c.State != tc.wantState || c.Reason != tc.wantReason {
				t.Fatalf("server_connection = %+v, want state %q reason %q", c, tc.wantState, tc.wantReason)
			}
		})
	}
}

// The API matches these exact literals (apps/api agentHealthObservations.ts
// derivePlaintextServerConnection); a rename on one side alone would silently
// drop the device notice, so the wire bytes are pinned here, not the consts.
func TestObserveServerConnection_WireLiterals(t *testing.T) {
	h := &Heartbeat{config: &config.Config{AgentID: "agent-1", ServerURL: "http://rmm.example.com"}, healthMon: health.NewMonitor()}
	h.observeServerConnection()
	snap := h.healthMon.Snapshot(health.SnapshotMetadata{AgentVersion: "1.0.0", ObservedAt: time.Now()})
	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	if want := `"server_connection":{"state":"warning","reason":"plaintext_websocket"}`; !strings.Contains(string(raw), want) {
		t.Fatalf("healthStatus JSON = %s, want it to contain %s", raw, want)
	}
}

// The server URL can change at runtime (backup promotion, a config push), so
// the component follows the current URL on every beat.
func TestObserveServerConnection_FollowsServerURLChange(t *testing.T) {
	cfg := &config.Config{AgentID: "agent-1", ServerURL: "http://rmm.example.com"}
	h := &Heartbeat{config: cfg, healthMon: health.NewMonitor()}

	h.observeServerConnection()
	if c := serverConnectionComponent(t, h); c.State != health.AgentHealthWarning {
		t.Fatalf("http server: %+v, want warning", c)
	}

	h.mu.Lock()
	cfg.ServerURL = "https://rmm.example.com"
	h.mu.Unlock()
	h.observeServerConnection()
	if c := serverConnectionComponent(t, h); c.State != health.AgentHealthHealthy || c.Reason != "" {
		t.Fatalf("after switch to https: %+v, want healthy with no reason", c)
	}
}

// Monitor.Update warn-logs every non-healthy call. A steady plaintext server
// must not add a warning line to every heartbeat.
func TestObserveServerConnection_UpdatesOnlyOnChange(t *testing.T) {
	buf := &syncBuffer{}
	logging.Init("text", "debug", buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })

	h := &Heartbeat{config: &config.Config{AgentID: "agent-1", ServerURL: "http://rmm.example.com"}, healthMon: health.NewMonitor()}
	for range 5 {
		h.observeServerConnection()
	}
	if n := strings.Count(buf.String(), "component="+serverConnectionComponentName); n != 1 {
		t.Fatalf("got %d degraded log lines over 5 beats, want 1; log:\n%s", n, buf.String())
	}
}

// sendHeartbeat must observe the server connection before it takes the health
// snapshot, or the component would never reach the server.
func TestSendHeartbeat_ObservesServerConnectionBeforeSnapshot(t *testing.T) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "heartbeat.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var observePos, snapshotPos token.Pos
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "sendHeartbeat" || fn.Recv == nil {
			continue
		}
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			switch sel.Sel.Name {
			case "observeServerConnection":
				if observePos == token.NoPos {
					observePos = sel.Pos()
				}
			case "Snapshot":
				if snapshotPos == token.NoPos {
					snapshotPos = sel.Pos()
				}
			}
			return true
		})
	}
	if snapshotPos == token.NoPos {
		t.Fatal("sendHeartbeat no longer calls healthMon.Snapshot; update this test")
	}
	if observePos == token.NoPos {
		t.Fatal("sendHeartbeat does not call observeServerConnection")
	}
	if observePos > snapshotPos {
		t.Fatal("sendHeartbeat calls observeServerConnection after the health snapshot")
	}
}
