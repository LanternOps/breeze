package heartbeat

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	gwebsocket "github.com/gorilla/websocket"

	"github.com/breeze-rmm/agent/internal/config"
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
// dedupe, and only the hand-off of the delivery that RAN it clears the entry.
// A second delivery of the same id — answered "duplicate", or rejected before
// dedupe (pool full) — must not clear the entry of an execution still running.
func TestSetWebSocketClient_HandOffClearsOnlyTheExecutingDelivery(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	root := t.TempDir()
	h := newResultSubmitHeartbeat(srv.URL)
	h.backupOutbox = newBackupResultOutbox(root)
	h.commandJournal = newCommandJournal(commandJournalDir(root))
	if h.seenCommands == nil {
		h.seenCommands = make(map[string]time.Time)
	}
	h.accepting.Store(true)
	ws := websocket.New(&websocket.Config{ServerURL: "http://localhost", AgentID: "a", AuthToken: secmem.NewSecureString("t")},
		func(websocket.Command) websocket.CommandResult { return websocket.CommandResult{} })
	h.SetWebSocketClient(ws)
	if ws.OnResultHandedOff == nil {
		t.Fatal("SetWebSocketClient did not wire OnResultHandedOff")
	}
	journal := commandJournalDir(root)

	// Normal delivery: journaled while running, cleared by its own hand-off.
	// An unknown type keeps the handler side effect-free.
	first := websocket.Command{ID: journalTestCmdID, Type: "test_unknown_type"}
	res := h.HandleCommand(first)
	if left := jsonFilesIn(t, journal); len(left) != 1 {
		t.Fatalf("HandleCommand journaled %v, want one entry until the result is handed off", left)
	}
	ws.OnResultHandedOff(res)
	if left := jsonFilesIn(t, journal); len(left) != 0 {
		t.Fatalf("the executing delivery's hand-off did not clear the journal: %v", left)
	}

	// An execution still running (journaled, past dedupe, not yet returned).
	const runningID = "0c6e9a3e-6a3f-4d7e-9a43-1b2f3c4d5e71"
	running := Command{ID: runningID, Type: tools.CmdInstallPatches}
	h.markCommandSeen(runningID)
	h.commandJournal.Begin(running)

	dup := h.HandleCommand(websocket.Command{ID: runningID, Type: tools.CmdInstallPatches})
	if dup.Status != "duplicate" {
		t.Fatalf("second delivery status = %q, want duplicate", dup.Status)
	}
	ws.OnResultHandedOff(dup)
	// A pre-dedupe rejection of yet another delivery (pool full).
	ws.OnResultHandedOff(websocket.CommandResult{CommandID: runningID, Status: "failed", ExitCode: 1,
		Error: "command rejected, worker pool full"})
	if left := jsonFilesIn(t, journal); len(left) != 1 {
		t.Fatalf("another delivery's hand-off cleared a running command's journal entry: %v", left)
	}

	// The running execution finishes and is handed off.
	h.commandJournal.ExpectHandOff(running)
	ws.OnResultHandedOff(websocket.CommandResult{CommandID: runningID, Status: "completed"})
	if left := jsonFilesIn(t, journal); len(left) != 0 {
		t.Fatalf("the running execution's hand-off did not clear its entry: %v", left)
	}
}

// If the outbox cannot persist a refused result, the journal entry must
// survive the hand-off that follows, so the next start still reports the
// command failed instead of the result vanishing with no trace.
func TestPreserveUndeliveredResult_OutboxFailureKeepsTheJournalEntry(t *testing.T) {
	root := t.TempDir()
	blocked := filepath.Join(root, "blocked")
	if err := os.WriteFile(blocked, []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	journalDir := filepath.Join(root, "journal")
	h := &Heartbeat{
		backupOutbox:   newBackupResultOutbox(blocked), // MkdirAll fails: a file is in the way
		commandJournal: newCommandJournal(journalDir),
	}
	cmd := Command{ID: journalTestCmdID, Type: tools.CmdInstallPatches}
	h.commandJournal.Begin(cmd)
	h.commandJournal.ExpectHandOff(cmd)

	h.preserveUndeliveredResult(websocket.CommandResult{Type: "command_result", CommandID: journalTestCmdID, Status: "failed"})
	h.onWSResultHandedOff(websocket.CommandResult{CommandID: journalTestCmdID, Status: "failed"})

	if left := jsonFilesIn(t, journalDir); len(left) != 1 {
		t.Fatalf("journal = %v after an unpersistable result; want the entry kept for Recover", left)
	}
	working := newBackupResultOutbox(filepath.Join(root, "outbox"))
	if n := newCommandJournal(journalDir).Recover(working); n != 1 {
		t.Fatalf("Recover reported %d, want 1 for the result that was never persisted", n)
	}
}

// End and HandedOff for an id this process never journaled must not touch a
// file someone else left in the journal (e.g. the previous process's entry
// awaiting Recover).
func TestCommandJournal_EndIgnoresIdsItNeverJournaled(t *testing.T) {
	root := t.TempDir()
	dir := commandJournalDir(root)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	stray := filepath.Join(dir, journalTestCmdID+".json")
	if err := os.WriteFile(stray, []byte(`{"commandId":"`+journalTestCmdID+`","type":"install_patches"}`), 0600); err != nil {
		t.Fatal(err)
	}
	j := newCommandJournal(dir)
	j.End(journalTestCmdID)
	j.HandedOff(journalTestCmdID)
	j.End(journalTestCmdID)
	if _, err := os.Stat(stray); err != nil {
		t.Fatalf("End removed an entry this process never journaled: %v", err)
	}
}

// Recover drops entries it can never act on — and must not turn them into
// results: corrupt JSON, an id that is not a UUID, an ephemeral type, and a
// file whose name disagrees with its id (the path-traversal guard).
func TestCommandJournal_RecoverDropsCorruptAndHostileEntries(t *testing.T) {
	cases := map[string]string{
		"corrupt json":     `{not json`,
		"non-uuid id":      `{"commandId":"snmp-1","type":"install_patches"}`,
		"ephemeral type":   `{"commandId":"` + journalTestCmdID + `","type":"terminal_start"}`,
		"name/id mismatch": `{"commandId":"0c6e9a3e-6a3f-4d7e-9a43-1b2f3c4d5e72","type":"install_patches"}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			dir := commandJournalDir(root)
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, journalTestCmdID+".json")
			if err := os.WriteFile(path, []byte(body), 0600); err != nil {
				t.Fatal(err)
			}
			outbox := newBackupResultOutbox(root)
			if n := newCommandJournal(dir).Recover(outbox); n != 0 {
				t.Fatalf("Recover reported %d for a bad entry, want 0", n)
			}
			if got := flushAll(t, outbox); len(got) != 0 {
				t.Fatalf("a bad journal entry became a result: %+v", got)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("bad entry not removed (stat err=%v)", err)
			}
		})
	}
}

// An entry Recover cannot outbox now is kept for the next start, and leftover
// .tmp files from a crash mid-Begin are cleared.
func TestCommandJournal_RecoverKeepsEntryWhenOutboxFailsAndClearsTmp(t *testing.T) {
	root := t.TempDir()
	dir := commandJournalDir(root)
	newCommandJournal(dir).Begin(Command{ID: journalTestCmdID, Type: tools.CmdInstallPatches})
	tmp := filepath.Join(dir, "0c6e9a3e-6a3f-4d7e-9a43-1b2f3c4d5e73.json.tmp")
	if err := os.WriteFile(tmp, []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}
	blocked := filepath.Join(root, "blocked")
	if err := os.WriteFile(blocked, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}

	if n := newCommandJournal(dir).Recover(newBackupResultOutbox(blocked)); n != 0 {
		t.Fatalf("Recover reported %d with an unwritable outbox, want 0", n)
	}
	if left := jsonFilesIn(t, dir); len(left) != 1 {
		t.Fatalf("journal = %v; an entry that could not be outboxed must be kept", left)
	}
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Fatalf("leftover .tmp not cleared (stat err=%v)", err)
	}
}

// The constructor is where recovery runs in production; deleting that call
// would silently disable the whole restart path, so pin it.
func TestNewWithVersion_RecoversInterruptedCommands(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	outboxRoot := backupResultOutboxDir()
	if !strings.HasPrefix(outboxRoot, home) {
		t.Skipf("outbox dir %q is not under the test HOME on this host; cannot isolate", outboxRoot)
	}
	newCommandJournal(commandJournalDir(outboxRoot)).Begin(Command{ID: journalTestCmdID, Type: tools.CmdInstallPatches})

	_ = NewWithVersion(&config.Config{AgentID: "agent-1", ServerURL: "http://127.0.0.1:1", AuthToken: "t"}, "test", nil, nil)

	got := flushAll(t, newBackupResultOutbox(outboxRoot))
	if len(got) != 1 || got[0].CommandID != journalTestCmdID || got[0].Error != interruptedCommandError {
		t.Fatalf("after construction the outbox holds %+v, want the interrupted-command failure", got)
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
	root := t.TempDir()
	journaledDuringSubmit := make(chan int, 16)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		matches, _ := filepath.Glob(filepath.Join(commandJournalDir(root), "*.json"))
		journaledDuringSubmit <- len(matches)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	h := newResultSubmitHeartbeat(srv.URL)
	h.backupOutbox = newBackupResultOutbox(root)
	h.commandJournal = newCommandJournal(commandJournalDir(root))
	if h.seenCommands == nil {
		h.seenCommands = make(map[string]time.Time)
	}

	h.processCommand(Command{ID: journalTestCmdID, Type: "test_unknown_type"})

	select {
	case n := <-journaledDuringSubmit:
		if n != 1 {
			t.Fatalf("journal held %d entries while the result was being submitted, want 1", n)
		}
	default:
		t.Fatal("the REST submit never reached the server")
	}

	got := flushAll(t, h.backupOutbox)
	if len(got) != 1 || got[0].CommandID != journalTestCmdID || got[0].Type != "command_result" || got[0].Status != "failed" {
		t.Fatalf("outbox = %+v, want the undeliverable failed result for %s", got, journalTestCmdID)
	}
	if left := jsonFilesIn(t, commandJournalDir(root)); len(left) != 0 {
		t.Fatalf("journal still holds %v after the result was outboxed", left)
	}
}
