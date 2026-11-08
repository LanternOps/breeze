package heartbeat

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/websocket"
)

const handedOffTestType = "test_result_handed_off"

// handedOffHarness registers a handler that hands its result to another
// process (#11154: the Windows self_uninstall helper reports it once the
// teardown is verified) and counts every result POST the agent makes.
func handedOffHarness(t *testing.T) (*Heartbeat, *atomic.Int32, string) {
	t.Helper()
	handlerRegistry[handedOffTestType] = func(*Heartbeat, Command) tools.CommandResult {
		return tools.CommandResult{Status: tools.StatusResultHandedOff}
	}
	t.Cleanup(func() { delete(handlerRegistry, handedOffTestType) })

	var posts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/result") {
			posts.Add(1)
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	root := t.TempDir()
	h := newResultSubmitHeartbeat(srv.URL)
	h.backupOutbox = newBackupResultOutbox(root)
	h.commandJournal = newCommandJournal(commandJournalDir(root))
	if h.seenCommands == nil {
		h.seenCommands = make(map[string]time.Time)
	}
	h.accepting.Store(true)
	return h, &posts, commandJournalDir(root)
}

// The heartbeat-poll path: a handed-off result is not POSTed, and the journal
// entry stays, so an agent that restarts after a failed helper still reports
// the command failed instead of nothing.
func TestProcessCommandDoesNotDeliverAHandedOffResult(t *testing.T) {
	h, posts, journal := handedOffHarness(t)

	h.processCommand(Command{ID: journalTestCmdID, Type: handedOffTestType})

	if n := posts.Load(); n != 0 {
		t.Fatalf("agent POSTed %d results for a command whose result another process owns", n)
	}
	if left := jsonFilesIn(t, journal); len(left) != 1 {
		t.Fatalf("journal = %v, want the entry kept for a restart to report", left)
	}
	if got := flushAll(t, h.backupOutbox); len(got) != 0 {
		t.Fatalf("handed-off result went to the outbox: %+v", got)
	}
}

// The websocket path: HandleCommand neither POSTs it asynchronously nor arms
// the journal hand-off, and the websocket client does not send it.
func TestHandleCommandDoesNotDeliverAHandedOffResult(t *testing.T) {
	h, posts, journal := handedOffHarness(t)
	ws := websocket.New(&websocket.Config{ServerURL: "http://localhost", AgentID: "a", AuthToken: secmem.NewSecureString("t")},
		func(websocket.Command) websocket.CommandResult { return websocket.CommandResult{} })
	h.SetWebSocketClient(ws)

	res := h.HandleCommand(websocket.Command{ID: journalTestCmdID, Type: handedOffTestType})
	if res.Status != tools.StatusResultHandedOff {
		t.Fatalf("status = %q, want the hand-off marker for the websocket client to drop", res.Status)
	}
	// The websocket client never hands it off, but even a stray hand-off
	// must not clear the entry.
	ws.OnResultHandedOff(res)
	time.Sleep(200 * time.Millisecond) // the async REST submit, if any, would land by now
	if n := posts.Load(); n != 0 {
		t.Fatalf("agent POSTed %d results for a handed-off command", n)
	}
	if left := jsonFilesIn(t, journal); len(left) != 1 {
		t.Fatalf("journal = %v, want the entry kept", left)
	}
}
