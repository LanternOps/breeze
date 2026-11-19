package websocket

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/wire"
)

// #11154: a result another process will report (the Windows self_uninstall
// helper) is dropped here — not sent, not outboxed, and not handed off, so the
// heartbeat keeps the command's journal entry. Covers both a connected client
// and one with no socket held (which would otherwise persist it).
func TestProcessCommand_DropsAHandedOffResult(t *testing.T) {
	s := newScriptedWSServer(t, nil)
	connected := newTestClient(s.srv.URL, func(Command) CommandResult {
		return CommandResult{Status: wire.ResultStatusHandedOff}
	})
	if err := connected.connect(); err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(connected.Stop)
	s.next(t)

	disconnected := newTestClient("http://localhost", func(Command) CommandResult {
		return CommandResult{Status: wire.ResultStatusHandedOff}
	})
	disconnected.PersistResultWhileDisconnected = func(Command) bool { return true }

	for name, c := range map[string]*Client{"connected": connected, "disconnected": disconnected} {
		t.Run(name, func(t *testing.T) {
			c.OnResultWriteFailed = func(r CommandResult) { t.Errorf("handed-off result outboxed: %+v", r) }
			c.OnResultHandedOff = func(r CommandResult) { t.Errorf("handed-off result handed off: %+v", r) }

			c.processCommand(Command{ID: "3bb7ac81-be24-4206-8896-f5cf7dbea12b", Type: "self_uninstall"})

			if n := len(c.resultChan); n != 0 {
				t.Fatalf("resultChan holds %d results, want none", n)
			}
		})
	}
}
