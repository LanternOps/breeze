package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/websocket"
)

// W09 (#8148): only journaled, server-tracked commands send their result to
// the outbox while the socket is down; ephemeral ones keep buffering.
func TestPersistResultWhileDisconnectedMatchesJournal(t *testing.T) {
	h := &Heartbeat{backupOutbox: newBackupResultOutbox(t.TempDir())}
	ws := websocket.New(&websocket.Config{ServerURL: "http://127.0.0.1:1", AgentID: "a", AuthToken: secmem.NewSecureString("t")}, nil)
	h.SetWebSocketClient(ws)
	if ws.PersistResultWhileDisconnected == nil {
		t.Fatal("SetWebSocketClient did not wire PersistResultWhileDisconnected")
	}
	const uuid = "1b4e28ba-2fa1-11d2-883f-0016d3cca427"
	cases := []struct {
		cmd  websocket.Command
		want bool
	}{
		{websocket.Command{ID: uuid, Type: tools.CmdInstallPatches}, true},
		{websocket.Command{ID: "mon-123", Type: "service_check"}, false},
		{websocket.Command{ID: "term-1", Type: tools.CmdTerminalData}, false},
		{websocket.Command{ID: uuid, Type: tools.CmdTerminalData}, false},
	}
	for _, tc := range cases {
		if got := ws.PersistResultWhileDisconnected(tc.cmd); got != tc.want {
			t.Errorf("PersistResultWhileDisconnected(%+v) = %v, want %v", tc.cmd, got, tc.want)
		}
	}
}
