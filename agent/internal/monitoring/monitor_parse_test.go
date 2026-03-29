package monitoring

import (
	"encoding/json"
	"testing"
)

// --- ParseMonitorConfig tests ---

func TestParseMonitorConfigValidMap(t *testing.T) {
	raw := map[string]any{
		"check_interval_seconds": float64(30),
		"watches": []any{
			map[string]any{
				"watch_type":                       "service",
				"name":                             "nginx",
				"alert_on_stop":                    true,
				"alert_after_consecutive_failures": float64(3),
				"auto_restart":                     true,
				"max_restart_attempts":             float64(5),
				"restart_cooldown_seconds":         float64(60),
			},
		},
	}

	cfg, ok := ParseMonitorConfig(raw)
	if !ok {
		t.Fatal("ParseMonitorConfig returned false for valid input")
	}

	if cfg.CheckIntervalSeconds != 30 {
		t.Errorf("CheckIntervalSeconds = %d, want 30", cfg.CheckIntervalSeconds)
	}
	if len(cfg.Watches) != 1 {
		t.Fatalf("len(Watches) = %d, want 1", len(cfg.Watches))
	}
	if cfg.Watches[0].Name != "nginx" {
		t.Errorf("Watches[0].Name = %q, want %q", cfg.Watches[0].Name, "nginx")
	}
	if !cfg.Watches[0].AutoRestart {
		t.Error("Watches[0].AutoRestart = false, want true")
	}
}

func TestParseMonitorConfigEmptyWatches(t *testing.T) {
	raw := map[string]any{
		"check_interval_seconds": float64(60),
		"watches":                []any{},
	}

	cfg, ok := ParseMonitorConfig(raw)
	if !ok {
		t.Fatal("ParseMonitorConfig should return true for empty watches")
	}
	if len(cfg.Watches) != 0 {
		t.Errorf("len(Watches) = %d, want 0", len(cfg.Watches))
	}
}

func TestParseMonitorConfigNilInput(t *testing.T) {
	cfg, ok := ParseMonitorConfig(nil)
	if !ok {
		t.Fatal("ParseMonitorConfig(nil) should return true (null marshals to valid JSON)")
	}
	if cfg.CheckIntervalSeconds != 0 {
		t.Errorf("CheckIntervalSeconds = %d, want 0 for nil input", cfg.CheckIntervalSeconds)
	}
}

func TestParseMonitorConfigFromJSONString(t *testing.T) {
	// Simulate what happens when the API sends a JSON-like structure
	// that gets decoded into map[string]any by the Go JSON decoder.
	jsonStr := `{
		"check_interval_seconds": 45,
		"watches": [
			{
				"watch_type": "process",
				"name": "node",
				"alert_on_stop": false,
				"alert_after_consecutive_failures": 1,
				"auto_restart": false,
				"max_restart_attempts": 0,
				"restart_cooldown_seconds": 0,
				"cpu_threshold_percent": 90.0,
				"memory_threshold_mb": 256.0,
				"threshold_duration_seconds": 60
			}
		]
	}`

	var raw any
	if err := json.Unmarshal([]byte(jsonStr), &raw); err != nil {
		t.Fatalf("failed to parse test JSON: %v", err)
	}

	cfg, ok := ParseMonitorConfig(raw)
	if !ok {
		t.Fatal("ParseMonitorConfig should return true for valid JSON input")
	}

	if cfg.CheckIntervalSeconds != 45 {
		t.Errorf("CheckIntervalSeconds = %d, want 45", cfg.CheckIntervalSeconds)
	}
	if len(cfg.Watches) != 1 {
		t.Fatalf("len(Watches) = %d, want 1", len(cfg.Watches))
	}

	w := cfg.Watches[0]
	if w.WatchType != WatchTypeProcess {
		t.Errorf("WatchType = %q, want %q", w.WatchType, WatchTypeProcess)
	}
	if w.CpuThresholdPercent != 90.0 {
		t.Errorf("CpuThresholdPercent = %f, want 90.0", w.CpuThresholdPercent)
	}
	if w.MemoryThresholdMb != 256.0 {
		t.Errorf("MemoryThresholdMb = %f, want 256.0", w.MemoryThresholdMb)
	}
	if w.ThresholdDurationSeconds != 60 {
		t.Errorf("ThresholdDurationSeconds = %d, want 60", w.ThresholdDurationSeconds)
	}
}

func TestParseMonitorConfigInvalidType(t *testing.T) {
	// A channel cannot be marshaled to JSON
	ch := make(chan int)
	_, ok := ParseMonitorConfig(ch)
	if ok {
		t.Error("ParseMonitorConfig should return false for unmarshalable input")
	}
}

func TestParseMonitorConfigMultipleWatches(t *testing.T) {
	raw := map[string]any{
		"check_interval_seconds": float64(15),
		"watches": []any{
			map[string]any{
				"watch_type": "service",
				"name":       "nginx",
			},
			map[string]any{
				"watch_type": "service",
				"name":       "postgresql",
			},
			map[string]any{
				"watch_type": "process",
				"name":       "node",
			},
		},
	}

	cfg, ok := ParseMonitorConfig(raw)
	if !ok {
		t.Fatal("ParseMonitorConfig returned false for valid input")
	}
	if len(cfg.Watches) != 3 {
		t.Fatalf("len(Watches) = %d, want 3", len(cfg.Watches))
	}

	names := make(map[string]bool)
	for _, w := range cfg.Watches {
		names[w.Name] = true
	}
	for _, expected := range []string{"nginx", "postgresql", "node"} {
		if !names[expected] {
			t.Errorf("expected watch named %q not found", expected)
		}
	}
}

// --- Edge case: ParseMonitorConfig with nested structures ---

func TestParseMonitorConfigIgnoresExtraFields(t *testing.T) {
	raw := map[string]any{
		"check_interval_seconds": float64(30),
		"unknown_field":          "should be ignored",
		"watches": []any{
			map[string]any{
				"watch_type":   "service",
				"name":         "test",
				"extra_field":  "ignored",
				"nested_extra": map[string]any{"foo": "bar"},
			},
		},
	}

	cfg, ok := ParseMonitorConfig(raw)
	if !ok {
		t.Fatal("ParseMonitorConfig should not fail on extra fields")
	}
	if len(cfg.Watches) != 1 {
		t.Fatalf("len(Watches) = %d, want 1", len(cfg.Watches))
	}
	if cfg.Watches[0].Name != "test" {
		t.Errorf("Watches[0].Name = %q, want %q", cfg.Watches[0].Name, "test")
	}
}

func TestParseMonitorConfigZeroValues(t *testing.T) {
	raw := map[string]any{
		"check_interval_seconds": float64(0),
		"watches": []any{
			map[string]any{
				"watch_type":                       "service",
				"name":                             "test",
				"alert_on_stop":                    false,
				"alert_after_consecutive_failures": float64(0),
				"auto_restart":                     false,
				"max_restart_attempts":             float64(0),
				"restart_cooldown_seconds":         float64(0),
			},
		},
	}

	cfg, ok := ParseMonitorConfig(raw)
	if !ok {
		t.Fatal("ParseMonitorConfig should handle zero values")
	}

	w := cfg.Watches[0]
	if w.AlertOnStop {
		t.Error("AlertOnStop should be false")
	}
	if w.AutoRestart {
		t.Error("AutoRestart should be false")
	}
	if w.MaxRestartAttempts != 0 {
		t.Errorf("MaxRestartAttempts = %d, want 0", w.MaxRestartAttempts)
	}
}
