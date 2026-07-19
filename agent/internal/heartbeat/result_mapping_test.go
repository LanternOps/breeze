package heartbeat

import (
	"encoding/json"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// TestToWSCommandResultCarriesStderrAndExitCode is the regression guard for
// #2474: the WS leg used to drop stderr and the exit code, so a script that
// wrote only to stderr and exited nonzero persisted as failed with no visible
// output and a NULL exit_code.
func TestToWSCommandResultCarriesStderrAndExitCode(t *testing.T) {
	in := tools.CommandResult{
		Status:   "failed",
		ExitCode: 3,
		Stdout:   "line one\nline two",
		Stderr:   "something went wrong",
	}

	got := toWSCommandResult("cmd-1", in)

	if got.CommandID != "cmd-1" {
		t.Errorf("CommandID = %q, want %q", got.CommandID, "cmd-1")
	}
	if got.Status != "failed" {
		t.Errorf("Status = %q, want %q", got.Status, "failed")
	}
	if got.ExitCode != 3 {
		t.Errorf("ExitCode = %d, want 3 (was dropped before #2474)", got.ExitCode)
	}
	if got.Stderr != "something went wrong" {
		t.Errorf("Stderr = %q, want %q (was dropped before #2474)", got.Stderr, "something went wrong")
	}
	if got.Stdout != "line one\nline two" {
		t.Errorf("Stdout = %q, want the raw multi-line text (was mangled via Result before #2474)", got.Stdout)
	}
}

// TestToWSCommandResultExitZeroIsWireVisible proves a successful command (exit
// 0) still serializes an explicit "exitCode":0. If exitCode were omitempty the
// server would coalesce it to NULL for every completed row — the exact symptom
// #2474 set out to fix.
func TestToWSCommandResultExitZeroIsWireVisible(t *testing.T) {
	got := toWSCommandResult("cmd-2", tools.CommandResult{
		Status:   "completed",
		ExitCode: 0,
		Stdout:   "ok",
	})

	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	ec, ok := wire["exitCode"]
	if !ok {
		t.Fatalf("exitCode absent from wire result %s; a completed command must send exitCode:0, not omit it", raw)
	}
	if ec.(float64) != 0 {
		t.Errorf("exitCode = %v, want 0", ec)
	}
}

// TestToWSCommandResultPreservesStructuredResult confirms the stdout->Result
// reparse that structured handlers (discovery/backup/snmp/monitor) depend on is
// preserved: JSON stdout still lands in the `result` field.
func TestToWSCommandResultPreservesStructuredResult(t *testing.T) {
	got := toWSCommandResult("cmd-3", tools.CommandResult{
		Status: "completed",
		Stdout: `{"devices":2}`,
	})

	obj, ok := got.Result.(map[string]any)
	if !ok {
		t.Fatalf("Result = %#v, want parsed JSON object", got.Result)
	}
	if obj["devices"].(float64) != 2 {
		t.Errorf("Result[devices] = %v, want 2", obj["devices"])
	}
}
