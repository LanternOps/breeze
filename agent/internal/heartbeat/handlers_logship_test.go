package heartbeat

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/secmem"
)

// initTestShipper initializes a global shipper so SetShipperLevel succeeds in tests.
func initTestShipper(t *testing.T) string {
	t.Helper()
	overridePath := filepath.Join(t.TempDir(), logging.LevelOverrideFileName)
	logging.InitShipper(logging.ShipperConfig{
		ServerURL:         func() string { return "http://localhost:3001" },
		AgentID:           "test-agent",
		AuthToken:         secmem.NewSecureString("test-token"),
		AgentVersion:      "1.0.0",
		MinLevel:          "warn",
		LevelOverridePath: overridePath,
	})
	t.Cleanup(func() { logging.StopShipper() })
	return overridePath
}

func decodeLogLevelResult(t *testing.T, stdout string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(stdout), &out); err != nil {
		t.Fatalf("result stdout is not JSON: %v (%q)", err, stdout)
	}
	return out
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
					"durationMinutes": 5,
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
			"durationMinutes": 5,
		},
	})
	if result.Status != "failed" {
		t.Fatalf("expected failed when shipper not initialized, got %s", result.Status)
	}
	if result.Error == "" {
		t.Fatal("expected error about shipper not initialized")
	}
}

// #7416: the override must be bounded. A missing or non-positive duration
// used to mean "never revert"; it now means the 60-minute default, and
// anything above 24h is clamped.
func TestHandleSetLogLevelDurationIsAlwaysBounded(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]any
		want    float64
	}{
		{"missing", map[string]any{"level": "debug"}, 60},
		{"zero", map[string]any{"level": "debug", "durationMinutes": 0}, 60},
		{"negative", map[string]any{"level": "debug", "durationMinutes": -5}, 60},
		{"over cap", map[string]any{"level": "debug", "durationMinutes": 100000}, 1440},
		{"in range", map[string]any{"level": "debug", "durationMinutes": 30}, 30},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			initTestShipper(t)
			before := time.Now()
			result := handleSetLogLevel(nil, Command{ID: "cmd-1", Type: tools.CmdSetLogLevel, Payload: tt.payload})
			if result.Status != "completed" {
				t.Fatalf("expected completed, got %s (error: %s)", result.Status, result.Error)
			}
			out := decodeLogLevelResult(t, result.Stdout)
			if got := out["durationMinutes"]; got != tt.want {
				t.Fatalf("durationMinutes = %v, want %v", got, tt.want)
			}
			rawExpiry, _ := out["expiresAt"].(string)
			expiresAt, err := time.Parse(time.RFC3339, rawExpiry)
			if err != nil {
				t.Fatalf("expiresAt not RFC3339: %v", err)
			}
			wantExpiry := before.Add(time.Duration(tt.want) * time.Minute)
			if d := expiresAt.Sub(wantExpiry); d < -2*time.Second || d > 2*time.Second {
				t.Fatalf("expiresAt %v, want ~%v", expiresAt, wantExpiry)
			}
		})
	}
}

// #7416: the result must say what was actually applied and whether it will
// survive a restart / reach the helpers, not just echo the request.
func TestHandleSetLogLevelReportsAppliedAndPersisted(t *testing.T) {
	overridePath := initTestShipper(t)
	result := handleSetLogLevel(nil, Command{
		ID:      "cmd-1",
		Type:    tools.CmdSetLogLevel,
		Payload: map[string]any{"level": "debug", "durationMinutes": 30},
	})
	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s (error: %s)", result.Status, result.Error)
	}
	out := decodeLogLevelResult(t, result.Stdout)
	if out["appliedLevel"] != "debug" || out["newLevel"] != "debug" {
		t.Fatalf("applied/new level wrong: %v", out)
	}
	if out["baseLevel"] != "warn" {
		t.Fatalf("baseLevel = %v, want warn", out["baseLevel"])
	}
	if out["persisted"] != true {
		t.Fatalf("persisted = %v, want true (%v)", out["persisted"], out["persistError"])
	}
	o, ok, err := logging.ReadLevelOverride(overridePath, time.Now())
	if err != nil || !ok || o.Level != "debug" {
		t.Fatalf("override file not written: ok=%v err=%v o=%+v", ok, err, o)
	}
}
