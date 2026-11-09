package heartbeat

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/oemupdates"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// The run ended and its marker holds the outcome, but the process died before
// the result was handed off: report that outcome, not a generic failure (a
// successful flash must not read as failed).
func TestJournalReportsAnEndedRunsOutcome(t *testing.T) {
	root := t.TempDir()
	base, _ := filepath.EvalSymlinks(t.TempDir())
	store := oemupdates.NewDirStore(filepath.Join(base, "oem"))
	prev := oemStore
	oemStore = func() oemupdates.Store { return store }
	t.Cleanup(func() { oemStore = prev })
	ended := time.Now()
	if err := oemupdates.WriteMarker(store, oemupdates.Marker{
		CommandID: journalTestCmdID, Lane: "dell", StartedAt: ended.Add(-time.Hour), Stage: oemupdates.StageInstalling,
		ToolVersion: "5.7.2", FlashStarted: true, EndedAt: &ended, Outcome: oemupdates.OutcomeSuccessRebootRequired,
		RebootRequired: true,
	}); err != nil {
		t.Fatal(err)
	}
	outbox := newBackupResultOutbox(root)
	newCommandJournal(commandJournalDir(root)).Begin(Command{ID: journalTestCmdID, Type: tools.CmdOemUpdateRun})
	newCommandJournal(commandJournalDir(root)).Recover(outbox)
	got := flushAll(t, outbox)
	if len(got) != 1 {
		t.Fatalf("recovered = %+v", got)
	}
	var rr oemupdates.RunResult
	if err := json.Unmarshal([]byte(got[0].Stdout), &rr); err != nil {
		t.Fatalf("stdout = %q: %v", got[0].Stdout, err)
	}
	if rr.Outcome != oemupdates.OutcomeSuccessRebootRequired || errorCodeString(rr) != "result_lost_after_run" || !rr.RebootRequired || rr.Validate() != nil {
		t.Fatalf("run result = %+v", rr)
	}
}
