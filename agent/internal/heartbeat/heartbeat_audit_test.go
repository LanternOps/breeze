package heartbeat

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func TestStopDoesNotPanicWhenAuditLoggerUnavailable(t *testing.T) {
	cfg := config.Default()
	cfg.AuditEnabled = false

	h := New(cfg)

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Stop panicked without audit logger: %v", r)
		}
	}()

	h.Stop()
}

func TestExecuteCommandDoesNotPanicWithoutAuditLogger(t *testing.T) {
	h := &Heartbeat{}
	cmd := Command{ID: "cmd-1", Type: "unknown_command_type"}

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("executeCommand panicked without audit logger: %v", r)
		}
	}()

	result := h.executeCommand(cmd)
	if result.Status != "failed" {
		t.Fatalf("expected failed status, got %q", result.Status)
	}
	if !strings.Contains(result.Error, "unknown command type") {
		t.Fatalf("expected unknown command error, got %q", result.Error)
	}
}

// TestExecuteCommandDedupesOrdinaryCommands verifies the baseline dedup path:
// two executions with the same command id return "duplicate" on the second.
// Guards against someone accidentally removing the markCommandSeen check.
func TestExecuteCommandDedupesOrdinaryCommands(t *testing.T) {
	h := &Heartbeat{}
	cmd := Command{ID: "cmd-dedup-1", Type: "unknown_command_type"}

	first := h.executeCommand(cmd)
	if first.Status == "duplicate" {
		t.Fatalf("first execution should not be duplicate, got %q", first.Status)
	}

	second := h.executeCommand(cmd)
	if second.Status != "duplicate" {
		t.Fatalf("second execution must dedup, got %q", second.Status)
	}
}

// TestExecuteCommandDoesNotDedupeStartDesktop is the #434 regression test.
// The viewer's desktop-ws session UUID is stable across reconnect attempts, so
// the start_desktop commandId repeats on retry. The heartbeat must NOT dedup
// these; StartSession (and SendCommand duplicate rejection for the helper path)
// are responsible for serializing the actual work. If this test fails, the
// viewer handoff after user logout silently dies into "session ended" — see
// issue #434 for the full repro trace.
func TestExecuteCommandDoesNotDedupeStartDesktop(t *testing.T) {
	h := &Heartbeat{}
	cmd := Command{ID: "desk-start-stable-uuid", Type: tools.CmdStartDesktop}

	first := h.executeCommand(cmd)
	if first.Status == "duplicate" {
		t.Fatalf("start_desktop must bypass dedup (#434): first=%q", first.Status)
	}

	second := h.executeCommand(cmd)
	if second.Status == "duplicate" {
		t.Fatalf("start_desktop retry must bypass dedup (#434): second=%q", second.Status)
	}
}

// TestExecuteCommandDoesNotDedupeStopDesktop mirrors the start_desktop
// regression test for stop_desktop, which is also idempotent state-setting and
// was bundled in the same exemption.
func TestExecuteCommandDoesNotDedupeStopDesktop(t *testing.T) {
	h := &Heartbeat{}
	cmd := Command{ID: "desk-stop-stable-uuid", Type: tools.CmdStopDesktop}

	first := h.executeCommand(cmd)
	if first.Status == "duplicate" {
		t.Fatalf("stop_desktop must bypass dedup (#434): first=%q", first.Status)
	}

	second := h.executeCommand(cmd)
	if second.Status == "duplicate" {
		t.Fatalf("stop_desktop retry must bypass dedup (#434): second=%q", second.Status)
	}
}
