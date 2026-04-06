package tools

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/terminal"
)

func TestWriteTerminalRejectsOversizedPayload(t *testing.T) {
	mgr := terminal.NewManager()

	result := WriteTerminal(mgr, map[string]any{
		"sessionId": "missing",
		"data":      strings.Repeat("a", maxTerminalWriteBytes+1),
	})

	if result.Status != "failed" {
		t.Fatalf("expected failed, got %q", result.Status)
	}
	if !strings.Contains(result.Error, "terminal input too large") {
		t.Fatalf("unexpected error: %s", result.Error)
	}
}

func TestNormalizeTerminalSizeClampsBounds(t *testing.T) {
	cols, rows := normalizeTerminalSize(-10, -20)
	if cols != minTerminalCols || rows != minTerminalRows {
		t.Fatalf("expected min clamp to %dx%d, got %dx%d", minTerminalCols, minTerminalRows, cols, rows)
	}

	cols, rows = normalizeTerminalSize(10_000, 10_000)
	if cols != maxTerminalCols || rows != maxTerminalRows {
		t.Fatalf("expected max clamp to %dx%d, got %dx%d", maxTerminalCols, maxTerminalRows, cols, rows)
	}
}
