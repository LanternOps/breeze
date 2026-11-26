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

// serverConnectionComponent returns the server_connection component of the
// current snapshot and whether it is present at all.
func serverConnectionComponent(t *testing.T, h *Heartbeat) (health.AgentHealthComponent, bool) {
	t.Helper()
	snap := h.healthMon.Snapshot(health.SnapshotMetadata{AgentVersion: "1.0.0", ObservedAt: time.Now()})
	c, ok := snap.Components[serverConnectionComponentName]
	return c, ok
}

// The component is sent only while there is something to report. One
// observation row is stored per heartbeat, so a "healthy" entry from every
// agent would add bytes to every row to say nothing.
func TestObserveServerConnection_PresentOnlyForPlaintextRemoteServer(t *testing.T) {
	cases := []struct {
		name        string
		serverURL   string
		wantPresent bool
	}{
		{"https public host", "https://rmm.example.com", false},
		{"http public host", "http://rmm.example.com:3001", true},
		{"http private LAN host", "http://192.168.1.20:3001", true},
		{"http localhost", "http://localhost:3001", false},
		{"http IPv4 loopback", "http://127.0.0.1:3001", false},
		{"http IPv6 loopback", "http://[::1]:3001", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := &Heartbeat{config: &config.Config{AgentID: "agent-1", ServerURL: tc.serverURL}, healthMon: health.NewMonitor()}
			h.observeServerConnection()
			c, ok := serverConnectionComponent(t, h)
			if ok != tc.wantPresent {
				t.Fatalf("server_connection present = %v (%+v), want %v", ok, c, tc.wantPresent)
			}
			if ok && (c.State != health.AgentHealthWarning || c.Reason != serverConnectionPlaintextReason) {
				t.Fatalf("server_connection = %+v, want state warning reason %q", c, serverConnectionPlaintextReason)
			}
		})
	}
}

// An encrypted agent's heartbeat carries no server_connection bytes at all.
func TestObserveServerConnection_EncryptedAgentSendsNoComponent(t *testing.T) {
	h := &Heartbeat{config: &config.Config{AgentID: "agent-1", ServerURL: "https://rmm.example.com"}, healthMon: health.NewMonitor()}
	h.observeServerConnection()
	raw, err := json.Marshal(h.healthMon.Snapshot(health.SnapshotMetadata{AgentVersion: "1.0.0", ObservedAt: time.Now()}))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), serverConnectionComponentName) {
		t.Fatalf("healthStatus JSON = %s, want no %s component", raw, serverConnectionComponentName)
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
// the component follows the current URL on every beat: present for a
// plaintext URL, removed once the URL is https, back if it turns plaintext.
func TestObserveServerConnection_FollowsServerURLChange(t *testing.T) {
	cfg := &config.Config{AgentID: "agent-1", ServerURL: "http://rmm.example.com"}
	h := &Heartbeat{config: cfg, healthMon: health.NewMonitor()}

	h.observeServerConnection()
	if c, ok := serverConnectionComponent(t, h); !ok || c.State != health.AgentHealthWarning {
		t.Fatalf("http server: present=%v %+v, want a warning component", ok, c)
	}

	h.mu.Lock()
	cfg.ServerURL = "https://rmm.example.com"
	h.mu.Unlock()
	h.observeServerConnection()
	if c, ok := serverConnectionComponent(t, h); ok {
		t.Fatalf("after switch to https: component still present %+v, want it removed", c)
	}

	h.mu.Lock()
	cfg.ServerURL = "http://rmm.example.com"
	h.mu.Unlock()
	h.observeServerConnection()
	if c, ok := serverConnectionComponent(t, h); !ok || c.State != health.AgentHealthWarning {
		t.Fatalf("after switch back to http: present=%v %+v, want a warning component", ok, c)
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
