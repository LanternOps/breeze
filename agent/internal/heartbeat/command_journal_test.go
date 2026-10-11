package heartbeat

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	gwebsocket "github.com/gorilla/websocket"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/websocket"
)

const journalTestCmdID = "3bb7ac81-be24-4206-8896-f5cf7dbea12b"

func flushAll(t *testing.T, o *backupResultOutbox) []websocket.CommandResult {
	t.Helper()
	var out []websocket.CommandResult
	o.Flush(func(r websocket.CommandResult) error {
		out = append(out, r)
		return nil
	})
	return out
}

func jsonFilesIn(t *testing.T, dir string) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	return matches
}

// #8296 (b): a command that was running when the agent died — hard kill, or
// a shutdown that exited before the result was produced — has no result
// anywhere. The restarted agent must report it as failed (through the outbox,
// so it reaches the API on the first connect) instead of leaving the row in
// `sent` until the server's reaper fires hours later.
func TestCommandJournal_RecoverReportsInterruptedCommandAsFailed(t *testing.T) {
	root := t.TempDir()
	outbox := newBackupResultOutbox(root)

	before := newCommandJournal(commandJournalDir(root))
	before.Begin(Command{ID: journalTestCmdID, Type: tools.CmdInstallPatches})
	// ...the process dies here: no End.

	after := newCommandJournal(commandJournalDir(root))
	if n := after.Recover(outbox); n != 1 {
		t.Fatalf("Recover reported %d interrupted commands, want 1", n)
	}

	got := flushAll(t, outbox)
	if len(got) != 1 {
		t.Fatalf("outbox holds %d results after recovery, want 1: %+v", len(got), got)
	}
	r := got[0]
	if r.Type != "command_result" || r.CommandID != journalTestCmdID || r.Status != "failed" {
		t.Fatalf("recovered result = %+v, want a failed command_result for %s", r, journalTestCmdID)
	}
	if r.Error != interruptedCommandError {
		t.Fatalf("recovered result error = %q, want %q", r.Error, interruptedCommandError)
	}
	// A synthetic failure, not an observed exit: ExitCode is not omitempty, so
	// zero would persist a false "exited 0".
	if r.ExitCode == 0 {
		t.Fatal("recovered result carries exit code 0; a synthetic failure must not claim a clean exit")
	}
	if left := jsonFilesIn(t, commandJournalDir(root)); len(left) != 0 {
		t.Fatalf("journal still holds %v after recovery; a second restart would report it again", left)
	}
}

// If the real result reached the outbox before the process died, that result
// wins — recovery must not queue a contradicting synthetic failure for it.
func TestCommandJournal_RecoverPrefersARealOutboxedResult(t *testing.T) {
	root := t.TempDir()
	outbox := newBackupResultOutbox(root)

	j := newCommandJournal(commandJournalDir(root))
	j.Begin(Command{ID: journalTestCmdID, Type: tools.CmdInstallPatches})
	real := testResult(journalTestCmdID)
	outbox.Enqueue(real)
	// ...died after the outbox write, before the journal entry was cleared.

	if n := newCommandJournal(commandJournalDir(root)).Recover(outbox); n != 0 {
		t.Fatalf("Recover reported %d interrupted commands, want 0 (the real result is outboxed)", n)
	}
	got := flushAll(t, outbox)
	if len(got) != 1 || got[0].Status != "completed" {
		t.Fatalf("outbox = %+v, want only the real completed result", got)
	}
	if left := jsonFilesIn(t, commandJournalDir(root)); len(left) != 0 {
		t.Fatalf("journal still holds %v after recovery", left)
	}
}

func TestCommandJournal_EndClearsTheEntry(t *testing.T) {
	root := t.TempDir()
	outbox := newBackupResultOutbox(root)
	j := newCommandJournal(commandJournalDir(root))
	j.Begin(Command{ID: journalTestCmdID, Type: tools.CmdInstallPatches})
	j.End(journalTestCmdID)

	if n := newCommandJournal(commandJournalDir(root)).Recover(outbox); n != 0 {
		t.Fatalf("a command whose result was handed off was reported interrupted (%d)", n)
	}
	if got := flushAll(t, outbox); len(got) != 0 {
		t.Fatalf("outbox = %+v, want empty", got)
	}
}

// Only commands the server tracks by UUID (device_commands rows, discovery /
// backup / restore jobs) are journaled. Session-bound ephemeral commands and
// non-UUID WS-direct ids (mon-*, snmp-*, term-*) are not: a synthetic failure
// for them is noise at best and, for an SNMP poll, a false failure recorded.
func TestCommandJournal_SkipsEphemeralAndNonUUIDCommands(t *testing.T) {
	root := t.TempDir()
	j := newCommandJournal(commandJournalDir(root))
	j.Begin(Command{ID: "0c6e9a3e-6a3f-4d7e-9a43-1b2f3c4d5e6f", Type: tools.CmdTerminalStart})
	j.Begin(Command{ID: "0c6e9a3e-6a3f-4d7e-9a43-1b2f3c4d5e70", Type: tools.CmdTunnelData})
	j.Begin(Command{ID: "snmp-123", Type: tools.CmdInstallPatches})
	j.Begin(Command{ID: "../../etc/passwd", Type: tools.CmdInstallPatches})

	if left := jsonFilesIn(t, commandJournalDir(root)); len(left) != 0 {
		t.Fatalf("journaled %v, want nothing", left)
	}
}

// The journal lives in a subdirectory of the outbox root; the outbox must
// never mistake a journal entry for a result to flush.
func TestCommandJournal_DoesNotLeakIntoOutboxFlush(t *testing.T) {
	root := t.TempDir()
	outbox := newBackupResultOutbox(root)
	newCommandJournal(commandJournalDir(root)).Begin(Command{ID: journalTestCmdID, Type: tools.CmdInstallPatches})
	if got := flushAll(t, outbox); len(got) != 0 {
		t.Fatalf("outbox flushed a journal entry: %+v", got)
	}
}

// The WebSocket path: executeCommand journals a command once it passes
// dedupe, and the websocket client's hand-off notice clears it — except for a
// "duplicate" marker, whose original is still running under the same id.
func TestSetWebSocketClient_HandOffClearsTheJournal(t *testing.T) {
	root := t.TempDir()
	h := &Heartbeat{
		backupOutbox:   newBackupResultOutbox(root),
		commandJournal: newCommandJournal(commandJournalDir(root)),
		seenCommands:   make(map[string]time.Time),
	}
	ws := websocket.New(&websocket.Config{ServerURL: "http://localhost", AgentID: "a", AuthToken: secmem.NewSecureString("t")},
		func(websocket.Command) websocket.CommandResult { return websocket.CommandResult{} })
	h.SetWebSocketClient(ws)
	if ws.OnResultHandedOff == nil {
		t.Fatal("SetWebSocketClient did not wire OnResultHandedOff")
	}

	// An unknown type keeps the handler side effect-free; what matters is that
	// it passed dedupe and so is now "running" as far as the journal knows.
	_ = h.executeCommand(Command{ID: journalTestCmdID, Type: "test_unknown_type"})
	if left := jsonFilesIn(t, commandJournalDir(root)); len(left) != 1 {
		t.Fatalf("executeCommand journaled %v, want exactly one entry until the result is handed off", left)
	}

	dup := h.executeCommand(Command{ID: journalTestCmdID, Type: "test_unknown_type"})
	if dup.Status != "duplicate" {
		t.Fatalf("second delivery status = %q, want duplicate", dup.Status)
	}
	ws.OnResultHandedOff(toWSCommandResult(journalTestCmdID, dup))
	if left := jsonFilesIn(t, commandJournalDir(root)); len(left) != 1 {
		t.Fatalf("a duplicate's hand-off cleared the original's journal entry: %v", left)
	}

	ws.OnResultHandedOff(websocket.CommandResult{CommandID: journalTestCmdID, Status: "failed"})
	if left := jsonFilesIn(t, commandJournalDir(root)); len(left) != 0 {
		t.Fatalf("hand-off did not clear the journal: %v", left)
	}
}

// #8296 (a) end to end: the reporter's sequence. A command is running when
// shutdown stops the websocket client; its result is produced afterwards and
// is refused with "client is stopped". It must land in the on-disk outbox and
// be delivered by the NEXT process's first connect.
func TestResultProducedAfterStop_IsFlushedOnNextConnect(t *testing.T) {
	root := t.TempDir()
	upgrader := gwebsocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

	// --- first process: dispatches the command, then is stopped mid-run ---
	started := make(chan struct{})
	release := make(chan struct{})
	srv1 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		_ = conn.WriteJSON(map[string]any{"type": "connected"})
		_ = conn.WriteJSON(map[string]any{"id": journalTestCmdID, "type": tools.CmdInstallPatches})
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer srv1.Close()

	h1 := &Heartbeat{backupOutbox: newBackupResultOutbox(root)}
	ws1 := websocket.New(&websocket.Config{ServerURL: srv1.URL, AgentID: "a", AuthToken: secmem.NewSecureString("t")},
		func(cmd websocket.Command) websocket.CommandResult {
			close(started)
			<-release // still inside WUA when shutdown begins
			return websocket.CommandResult{Status: "failed", ExitCode: 1, Error: "WUA install failed"}
		})
	h1.SetWebSocketClient(ws1)
	go ws1.Start()

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("command never dispatched")
	}
	ws1.Stop()     // shutdown: drain timed out, transport torn down
	close(release) // ...and only now does the command finish

	deadline := time.Now().Add(5 * time.Second)
	for len(jsonFilesIn(t, root)) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("a result produced after Stop never reached the on-disk outbox")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// --- second process: same data dir, connects to a fresh server ---
	got := make(chan websocket.CommandResult, 4)
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		_ = conn.WriteJSON(map[string]any{"type": "connected"})
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var res websocket.CommandResult
			if json.Unmarshal(msg, &res) == nil && res.Type == "command_result" {
				got <- res
			}
		}
	}))
	defer srv2.Close()

	h2 := &Heartbeat{backupOutbox: newBackupResultOutbox(root)}
	ws2 := websocket.New(&websocket.Config{ServerURL: srv2.URL, AgentID: "a", AuthToken: secmem.NewSecureString("t")},
		func(websocket.Command) websocket.CommandResult { return websocket.CommandResult{} })
	h2.SetWebSocketClient(ws2)
	go ws2.Start()
	defer ws2.Stop()

	select {
	case res := <-got:
		if res.CommandID != journalTestCmdID || res.Status != "failed" || res.Error != "WUA install failed" {
			t.Fatalf("next connect delivered %+v, want the original failed install_patches result", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the outboxed result was not delivered on the next connect")
	}
}

// The heartbeat-poll (REST) path: a result whose POST fails for good must not
// just be logged — it goes to the outbox too, and its journal entry is cleared
// only after that.
func TestProcessCommand_RESTSubmitFailureGoesToOutbox(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	root := t.TempDir()
	h := newResultSubmitHeartbeat(srv.URL)
	h.backupOutbox = newBackupResultOutbox(root)
	h.commandJournal = newCommandJournal(commandJournalDir(root))
	if h.seenCommands == nil {
		h.seenCommands = make(map[string]time.Time)
	}

	h.processCommand(Command{ID: journalTestCmdID, Type: "test_unknown_type"})

	got := flushAll(t, h.backupOutbox)
	if len(got) != 1 || got[0].CommandID != journalTestCmdID || got[0].Type != "command_result" || got[0].Status != "failed" {
		t.Fatalf("outbox = %+v, want the undeliverable failed result for %s", got, journalTestCmdID)
	}
	if left := jsonFilesIn(t, commandJournalDir(root)); len(left) != 0 {
		t.Fatalf("journal still holds %v after the result was outboxed", left)
	}
}
