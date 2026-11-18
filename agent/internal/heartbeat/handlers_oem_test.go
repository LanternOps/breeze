package heartbeat

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/oemupdates"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

const oemTestCmdID = "6d1f0c2e-5b7a-4e8f-9a01-23456789abcd"

func oemPayload(t *testing.T, mutate func(map[string]any)) map[string]any {
	t.Helper()
	p := map[string]any{
		"lane":                 "dell",
		"trigger":              "on_demand",
		"occurrenceKey":        nil,
		"categories":           []any{"driver"},
		"blockedUpdateIds":     []any{},
		"rebootControlled":     true,
		"notAfter":             time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		"escrowedProtectorIds": []any{},
		"tool":                 nil,
	}
	if mutate != nil {
		mutate(p)
	}
	return p
}

type oemSeams struct {
	ran *oemupdates.RunRequest
}

func installOemSeams(t *testing.T, goos string, elevated bool) *oemSeams {
	t.Helper()
	s := &oemSeams{}
	prevGOOS, prevElevated, prevRun, prevDeps := oemGOOS, oemElevated, oemRun, oemDepsFor
	oemGOOS = goos
	oemElevated = func() bool { return elevated }
	oemRun = func(_ context.Context, req oemupdates.RunRequest, lane oemupdates.Lane, _ oemupdates.Deps) oemupdates.RunResult {
		s.ran = &req
		return oemupdates.RunResult{Lane: lane.ID(), Outcome: oemupdates.OutcomeSuccess, Takeover: oemupdates.TakeoverNotAttempted}
	}
	oemDepsFor = func(*Heartbeat, string) oemupdates.Deps { return oemupdates.Deps{} }
	t.Cleanup(func() { oemGOOS, oemElevated, oemRun, oemDepsFor = prevGOOS, prevElevated, prevRun, prevDeps })
	return s
}

func decodeOemResult(t *testing.T, r tools.CommandResult) oemupdates.RunResult {
	t.Helper()
	var out oemupdates.RunResult
	dec := json.NewDecoder(strings.NewReader(r.Stdout))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&out); err != nil {
		t.Fatalf("stdout is not a run result: %v (%q)", err, r.Stdout)
	}
	if err := out.Validate(); err != nil {
		t.Fatalf("run result violates the contract: %v", err)
	}
	return out
}

func errorCodeString(r oemupdates.RunResult) string {
	if r.ErrorCode == nil {
		return ""
	}
	return *r.ErrorCode
}

func TestOemHandlerRunsTheLane(t *testing.T) {
	s := installOemSeams(t, "windows", true)
	r := handleOemUpdateRun(nil, Command{ID: oemTestCmdID, Type: tools.CmdOemUpdateRun, Payload: oemPayload(t, nil)})
	if s.ran == nil || s.ran.CommandID != oemTestCmdID || s.ran.Lane != "dell" {
		t.Fatalf("run request = %+v", s.ran)
	}
	if r.Status != "completed" || r.ExitCode != 0 {
		t.Fatalf("result = %+v", r)
	}
	if got := decodeOemResult(t, r); got.Outcome != oemupdates.OutcomeSuccess {
		t.Fatalf("outcome = %s", got.Outcome)
	}
}

// §4.4: refused unless elevated, independent of the heartbeat's warn-only check.
func TestOemHandlerRefusesWhenNotElevated(t *testing.T) {
	s := installOemSeams(t, "windows", false)
	r := handleOemUpdateRun(nil, Command{ID: oemTestCmdID, Type: tools.CmdOemUpdateRun, Payload: oemPayload(t, nil)})
	if s.ran != nil {
		t.Fatal("the lane ran without elevation")
	}
	got := decodeOemResult(t, r)
	if got.Outcome != oemupdates.OutcomeFailed || errorCodeString(got) != "not_elevated" || r.Status != "failed" {
		t.Fatalf("result = %+v / %+v", r, got)
	}
}

func TestOemHandlerUnknownLaneFails(t *testing.T) {
	s := installOemSeams(t, "windows", true)
	r := handleOemUpdateRun(nil, Command{ID: oemTestCmdID, Type: tools.CmdOemUpdateRun,
		Payload: oemPayload(t, func(p map[string]any) { p["lane"] = "acme" })})
	if s.ran != nil || r.Status != "failed" || r.Stdout != "" {
		t.Fatalf("an unknown lane ran or produced a result body: %+v", r)
	}
	// A real lane this agent does not build yet answers not_supported.
	r = handleOemUpdateRun(nil, Command{ID: oemTestCmdID, Type: tools.CmdOemUpdateRun,
		Payload: oemPayload(t, func(p map[string]any) { p["lane"] = "lenovo" })})
	got := decodeOemResult(t, r)
	if s.ran != nil || got.Outcome != oemupdates.OutcomeNotSupported || errorCodeString(got) != "lane_not_built" || got.Lane != "lenovo" {
		t.Fatalf("result = %+v", got)
	}
}

func TestOemHandlerNonWindowsIsNotSupportedQuietly(t *testing.T) {
	s := installOemSeams(t, "darwin", true)
	var buf bytes.Buffer
	logging.Init("text", "debug", &buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })
	r := handleOemUpdateRun(nil, Command{ID: oemTestCmdID, Type: tools.CmdOemUpdateRun, Payload: oemPayload(t, nil)})
	got := decodeOemResult(t, r)
	if s.ran != nil || got.Outcome != oemupdates.OutcomeNotSupported || errorCodeString(got) != "os_not_supported" {
		t.Fatalf("result = %+v", got)
	}
	if strings.Contains(buf.String(), "level=WARN") || strings.Contains(buf.String(), "level=ERROR") {
		t.Fatalf("logged above INFO:\n%s", buf.String())
	}
}

func TestOemPayloadStrictParse(t *testing.T) {
	s := installOemSeams(t, "windows", true)
	for name, mutate := range map[string]func(map[string]any){
		"unknown key":      func(p map[string]any) { p["script"] = "calc.exe" },
		"missing notAfter": func(p map[string]any) { delete(p, "notAfter") },
		"bad category":     func(p map[string]any) { p["categories"] = []any{"everything"} },
	} {
		t.Run(name, func(t *testing.T) {
			r := handleOemUpdateRun(nil, Command{ID: oemTestCmdID, Type: tools.CmdOemUpdateRun, Payload: oemPayload(t, mutate)})
			if s.ran != nil || r.Status != "failed" || !strings.Contains(r.Error, "invalid oem_update_run payload") {
				t.Fatalf("result = %+v", r)
			}
		})
	}
}

func TestOemResultStatusFollowsOutcome(t *testing.T) {
	for outcome, want := range map[oemupdates.Outcome]string{
		oemupdates.OutcomeSuccess: "completed", oemupdates.OutcomeSuccessRebootRequired: "completed",
		oemupdates.OutcomeNoUpdates: "completed", oemupdates.OutcomePartial: "completed",
		oemupdates.OutcomeFailed: "failed", oemupdates.OutcomeInterrupted: "failed",
		oemupdates.OutcomeBlockedOnBattery: "failed", oemupdates.OutcomeRetryLater: "failed",
	} {
		r := oemCommandResult(oemupdates.RunResult{Lane: "dell", Outcome: outcome}, 0)
		if r.Status != want {
			t.Errorf("%s → %s, want %s", outcome, r.Status, want)
		}
		if r.Status == "failed" && r.ExitCode == 0 {
			t.Errorf("%s: a failed result claims exit 0", outcome)
		}
		decodeOemResult(t, r)
	}
}

// A stop during a run yields the marker's interrupted result, not only the
// journal's generic synthetic failure.
func TestJournalReportsOemRunInterruptedFromTheMarker(t *testing.T) {
	root := t.TempDir()
	base, _ := filepath.EvalSymlinks(t.TempDir())
	store := oemupdates.NewDirStore(filepath.Join(base, "oem"))
	prev := oemStore
	oemStore = func() oemupdates.Store { return store }
	t.Cleanup(func() { oemStore = prev })

	if err := oemupdates.WriteMarker(store, oemupdates.Marker{
		CommandID: journalTestCmdID, Lane: "dell", StartedAt: time.Now(), Stage: oemupdates.StageInstalling, FlashStarted: true,
	}); err != nil {
		t.Fatal(err)
	}
	outbox := newBackupResultOutbox(root)
	newCommandJournal(commandJournalDir(root)).Begin(Command{ID: journalTestCmdID, Type: tools.CmdOemUpdateRun})
	if n := newCommandJournal(commandJournalDir(root)).Recover(outbox); n != 1 {
		t.Fatalf("recovered %d", n)
	}
	got := flushAll(t, outbox)
	if len(got) != 1 || got[0].Status != "failed" || got[0].Error != interruptedCommandError || got[0].ExitCode == 0 {
		t.Fatalf("recovered = %+v", got)
	}
	var rr oemupdates.RunResult
	if err := json.Unmarshal([]byte(got[0].Stdout), &rr); err != nil {
		t.Fatalf("stdout = %q: %v", got[0].Stdout, err)
	}
	if rr.Outcome != oemupdates.OutcomeInterrupted || errorCodeString(rr) != "agent_restarted_during_installing" || rr.Validate() != nil {
		t.Fatalf("run result = %+v", rr)
	}
}

func TestJournalFallsBackWhenTheMarkerIsAnotherCommand(t *testing.T) {
	root := t.TempDir()
	base, _ := filepath.EvalSymlinks(t.TempDir())
	store := oemupdates.NewDirStore(filepath.Join(base, "oem"))
	prev := oemStore
	oemStore = func() oemupdates.Store { return store }
	t.Cleanup(func() { oemStore = prev })
	_ = oemupdates.WriteMarker(store, oemupdates.Marker{CommandID: oemTestCmdID, Lane: "dell", StartedAt: time.Now()})

	outbox := newBackupResultOutbox(root)
	newCommandJournal(commandJournalDir(root)).Begin(Command{ID: journalTestCmdID, Type: tools.CmdOemUpdateRun})
	newCommandJournal(commandJournalDir(root)).Recover(outbox)
	got := flushAll(t, outbox)
	if len(got) != 1 || got[0].Stdout != "" || got[0].Status != "failed" {
		t.Fatalf("recovered = %+v, want the generic failure", got)
	}
}
