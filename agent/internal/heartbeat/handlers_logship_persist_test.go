package heartbeat

import (
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/secmem"
)

// When the override file cannot be written the running service still ships
// at the new level, but the result must say it was not persisted rather than
// report a plain success (#7416).
func TestHandleSetLogLevelReportsPersistFailure(t *testing.T) {
	logging.InitShipper(logging.ShipperConfig{
		ServerURL:         func() string { return "http://localhost:3001" },
		AgentID:           "test-agent",
		AuthToken:         secmem.NewSecureString("test-token"),
		AgentVersion:      "1.0.0",
		MinLevel:          "warn",
		LevelOverridePath: filepath.Join(t.TempDir(), "missing-dir", logging.LevelOverrideFileName),
	})
	t.Cleanup(func() { logging.StopShipper() })

	result := handleSetLogLevel(nil, Command{
		ID:      "cmd-1",
		Type:    tools.CmdSetLogLevel,
		Payload: map[string]any{"level": "info", "durationMinutes": 10},
	})
	if result.Status != "completed" {
		t.Fatalf("expected completed (applied in memory), got %s (error: %s)", result.Status, result.Error)
	}
	out := decodeLogLevelResult(t, result.Stdout)
	if out["persisted"] != false {
		t.Fatalf("persisted = %v, want false", out["persisted"])
	}
	if msg, _ := out["persistError"].(string); msg == "" {
		t.Fatal("persistError missing")
	}
	if out["appliedLevel"] != "info" {
		t.Fatalf("appliedLevel = %v, want info", out["appliedLevel"])
	}
}
