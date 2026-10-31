package userhelper

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// A panicking command handler must still produce a failed result for the
// agent, so the caller gets an error instead of waiting out its IPC budget
// (#10304: take_screenshot panic surfaced as a 65 s timeout).
func TestRunCommandRecoveredTurnsPanicIntoFailedResult(t *testing.T) {
	cmd := ipc.IPCCommand{CommandID: "cmd-1", Type: "take_screenshot"}

	result := runCommandRecovered(cmd, func() ipc.IPCCommandResult {
		var p *struct{ x int }
		_ = p.x // nil dereference
		return ipc.IPCCommandResult{CommandID: cmd.CommandID, Status: "completed"}
	})

	if result.Status != "failed" {
		t.Fatalf("status = %q, want failed", result.Status)
	}
	if result.CommandID != "cmd-1" {
		t.Fatalf("commandId = %q, want cmd-1", result.CommandID)
	}
	if !strings.Contains(result.Error, "take_screenshot") || !strings.Contains(result.Error, "panic") {
		t.Fatalf("error = %q, want it to name the command and the panic", result.Error)
	}
}

func TestRunCommandRecoveredPassesThroughNormalResult(t *testing.T) {
	cmd := ipc.IPCCommand{CommandID: "cmd-2", Type: "exec"}
	want := ipc.IPCCommandResult{CommandID: "cmd-2", Status: "completed"}

	got := runCommandRecovered(cmd, func() ipc.IPCCommandResult { return want })

	if got.Status != want.Status || got.CommandID != want.CommandID || got.Error != "" {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}
