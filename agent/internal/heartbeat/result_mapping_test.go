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
		t.Errorf("ExitCode = %d, want 3", got.ExitCode)
	}
	if got.Stderr != "something went wrong" {
		t.Errorf("Stderr = %q, want %q", got.Stderr, "something went wrong")
	}
	if got.Stdout != "line one\nline two" {
		t.Errorf("Stdout = %q, want the raw multi-line text", got.Stdout)
	}
	// Non-JSON stdout must ride ONLY in Stdout. Duplicating it into Result
	// doubles the payload and, near the executor's 1MB stdout cap, trips the
	// server's 1MB refine on `result` — rejecting the whole command_result.
	if got.Result != nil {
		t.Errorf("Result = %#v, want nil for non-JSON stdout", got.Result)
	}
}

// TestToWSCommandResultErrorSuppressesResult pins the Error branch: when the
// handler reports an error, Result stays empty but stdout/stderr still flow —
// an errored script's captured output must remain visible in the UI.
func TestToWSCommandResultErrorSuppressesResult(t *testing.T) {
	got := toWSCommandResult("cmd-err", tools.CommandResult{
		Status:   "failed",
		ExitCode: 1,
		Error:    "boom",
		Stdout:   `{"partial":true}`,
		Stderr:   "trace",
	})

	if got.Error != "boom" {
		t.Errorf("Error = %q, want %q", got.Error, "boom")
	}
	if got.Result != nil {
		t.Errorf("Result = %#v, want nil when Error is set", got.Result)
	}
	if got.Stdout != `{"partial":true}` {
		t.Errorf("Stdout = %q, want it carried even when Error is set", got.Stdout)
	}
	if got.Stderr != "trace" {
		t.Errorf("Stderr = %q, want it carried even when Error is set", got.Stderr)
	}
}

// TestToWSCommandResultExitZeroIsWireVisible proves a successful command (exit
// 0) serializes an explicit "exitCode":0. If exitCode were omitempty the
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
