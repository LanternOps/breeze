package heartbeat

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
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
