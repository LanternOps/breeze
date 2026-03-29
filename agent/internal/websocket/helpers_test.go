package websocket

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/websocket"

	"github.com/breeze-rmm/agent/internal/secmem"
)

// ---------- helpers ----------

// upgrader for test WebSocket servers
var testUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// newTestServer creates an httptest.Server that upgrades to WebSocket and
// calls onConn with the server-side *websocket.Conn.  The returned server
// URL uses the "http" scheme so the client will convert it to "ws".
func newTestServer(t *testing.T, onConn func(conn *websocket.Conn)) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := testUpgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Logf("upgrade error: %v", err)
			return
		}
		onConn(conn)
	}))
	return srv
}

// noopHandler is a CommandHandler that does nothing.
func noopHandler(cmd Command) CommandResult {
	return CommandResult{Status: "ok"}
}

// echoHandler echoes back the command type in the result.
func echoHandler(cmd Command) CommandResult {
	return CommandResult{Status: "ok", Result: cmd.Type}
}

// newTestClient creates a Client pointed at the given test server URL.
func newTestClient(serverURL string, handler CommandHandler) *Client {
	cfg := &Config{
		ServerURL: serverURL,
		AgentID:   "test-agent-001",
		AuthToken: secmem.NewSecureString("brz_test_token"),
	}
	return New(cfg, handler)
}
