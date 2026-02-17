package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// initTestShipper initializes a global shipper so SetShipperLevel succeeds in tests.
func initTestShipper(t *testing.T) {
	t.Helper()
	logging.InitShipper(logging.ShipperConfig{
		ServerURL:    "http://localhost:3001",
		AgentID:      "test-agent",
		AuthToken:    "test-token",
		AgentVersion: "1.0.0",
		MinLevel:     "warn",
	})
	t.Cleanup(func() { logging.StopShipper() })
}

func TestHandleSetLogLevelMissingLevel(t *testing.T) {
	result := handleSetLogLevel(nil, Command{
		ID:      "cmd-1",
		Type:    tools.CmdSetLogLevel,
		Payload: map[string]any{},
	})

	if result.Status != "failed" {
		t.Fatalf("expected failed status, got %s", result.Status)
	}
	if result.Error == "" {
		t.Fatal("expected error message for missing level")
	}
}

func TestHandleSetLogLevelInvalidLevel(t *testing.T) {
	tests := []struct {
		name  string
		level string
	}{
		{"trace", "trace"},
		{"verbose", "verbose"},
		{"empty-non-param", "critical"},
		{"uppercase", "DEBUG"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := handleSetLogLevel(nil, Command{
				ID:   "cmd-1",
				Type: tools.CmdSetLogLevel,
				Payload: map[string]any{
					"level": tt.level,
				},
			})
			if result.Status != "failed" {
				t.Fatalf("expected failed for level %q, got %s", tt.level, result.Status)
			}
		})
	}
}

func TestHandleSetLogLevelValidLevels(t *testing.T) {
	initTestShipper(t)
	validLevels := []string{"debug", "info", "warn", "error"}

	for _, level := range validLevels {
		t.Run(level, func(t *testing.T) {
			result := handleSetLogLevel(nil, Command{
				ID:   "cmd-1",
				Type: tools.CmdSetLogLevel,
				Payload: map[string]any{
					"level":           level,
					"durationMinutes": 0, // disable auto-revert for test
				},
			})
			if result.Status != "completed" {
				t.Fatalf("expected completed for level %q, got %s (error: %s)",
					level, result.Status, result.Error)
			}
		})
	}
}

func TestHandleSetLogLevelNoShipper(t *testing.T) {
	// Without initTestShipper, SetShipperLevel should return false
	result := handleSetLogLevel(nil, Command{
		ID:   "cmd-1",
		Type: tools.CmdSetLogLevel,
		Payload: map[string]any{
			"level":           "debug",
			"durationMinutes": 0,
		},
	})
	if result.Status != "failed" {
		t.Fatalf("expected failed when shipper not initialized, got %s", result.Status)
	}
	if result.Error == "" {
		t.Fatal("expected error about shipper not initialized")
	}
}

func TestHandleSetLogLevelDefaultDuration(t *testing.T) {
	initTestShipper(t)
	result := handleSetLogLevel(nil, Command{
		ID:   "cmd-1",
		Type: tools.CmdSetLogLevel,
		Payload: map[string]any{
			"level":           "debug",
			"durationMinutes": 0, // disable goroutine for test safety
		},
	})

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s (error: %s)", result.Status, result.Error)
	}
	if result.Stdout == "" {
		t.Fatal("expected JSON output in Stdout")
	}
}
