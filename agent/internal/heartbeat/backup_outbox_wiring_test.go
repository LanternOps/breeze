package heartbeat

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	gwebsocket "github.com/gorilla/websocket"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/websocket"
)

// TestHandleBackupResult_NoWSClient_PersistsToOutbox proves FIX 2: a terminal
// backup result that arrives while there is no live WS client (agent startup or
// a WS teardown gap) is persisted to the outbox instead of being dropped, so
// the next reconnect flushes it. Before the fix, the handler early-returned
// when wsClient == nil, orphaning the server-side job as "running" forever.
func TestHandleBackupResult_NoWSClient_PersistsToOutbox(t *testing.T) {
	outbox := newBackupResultOutbox(filepath.Join(t.TempDir(), "outbox"))
	h := &Heartbeat{backupOutbox: outbox} // wsClient intentionally nil

	res := backupipc.BackupCommandResult{
		CommandID: "cmd-nows",
		Success:   true,
		Stdout:    `{"snapshotId":"abc"}`,
	}
	payload, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	env := &ipc.Envelope{ID: "e1", Type: backupipc.TypeBackupResult, Payload: payload}

	// Passing a nil session is safe: the backup-result branch does not touch it.
	h.handleUserHelperMessage(nil, env)

	entries, err := os.ReadDir(outbox.dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("expected 1 persisted outbox entry with nil wsClient, got %v (err=%v)", entries, err)
	}

	var delivered []websocket.CommandResult
	outbox.Flush(func(r websocket.CommandResult) error {
		delivered = append(delivered, r)
		return nil
	})
	if len(delivered) != 1 || delivered[0].CommandID != "cmd-nows" || delivered[0].Status != "completed" {
		t.Fatalf("outbox flushed %+v, want one completed cmd-nows", delivered)
	}
}

// TestSetWebSocketClient_ReconnectFlushesBackupOutbox proves the flush-on-
// reconnect wiring end-to-end: SetWebSocketClient points ws.OnConnected at
// flushBackupResultOutbox, so when the read pump parses the server's
// "connected" welcome frame on (re)connect, the pending outbox entry is
// redelivered over the fresh connection.
func TestSetWebSocketClient_ReconnectFlushesBackupOutbox(t *testing.T) {
	got := make(chan websocket.CommandResult, 1)
	upgrader := gwebsocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		// Welcome frame — this is what fires OnConnected on the client read pump.
		_ = conn.WriteJSON(map[string]any{"type": "connected"})
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var res websocket.CommandResult
			if json.Unmarshal(msg, &res) == nil && res.Type == "command_result" {
				select {
				case got <- res:
				default:
				}
			}
		}
	}))
	defer srv.Close()

	outbox := newBackupResultOutbox(filepath.Join(t.TempDir(), "outbox"))
	outbox.Enqueue(testResult("cmd-reconnect"))

	h := &Heartbeat{backupOutbox: outbox}
	cfg := &websocket.Config{
		ServerURL: srv.URL,
		AgentID:   "a",
		AuthToken: secmem.NewSecureString("tok"),
	}
	ws := websocket.New(cfg, func(websocket.Command) websocket.CommandResult {
		return websocket.CommandResult{}
	})
	h.SetWebSocketClient(ws)
	if ws.OnConnected == nil {
		t.Fatal("SetWebSocketClient did not wire OnConnected")
	}

	go ws.Start()
	defer ws.Stop()

	select {
	case res := <-got:
		if res.CommandID != "cmd-reconnect" {
			t.Fatalf("server received flushed result %q, want cmd-reconnect", res.CommandID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the outboxed backup result to be flushed on reconnect")
	}

	// Successful flush removes the persisted entry (removal happens before the
	// frame is written, so by the time the server receives it the dir is drained).
	if entries, err := os.ReadDir(outbox.dir); err != nil || len(entries) != 0 {
		t.Fatalf("expected outbox drained after successful flush, got %v (err=%v)", entries, err)
	}
}
