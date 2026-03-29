package monitoring

import (
	"encoding/json"
	"testing"
)

func TestWatchTypeConstants(t *testing.T) {
	tests := []struct {
		name string
		got  WatchType
		want string
	}{
		{"WatchTypeService", WatchTypeService, "service"},
		{"WatchTypeProcess", WatchTypeProcess, "process"},
	}

	for _, tt := range tests {
		if tt.got != tt.want {
			t.Errorf("%s = %q, want %q", tt.name, tt.got, tt.want)
		}
	}
}

func TestCheckStatusConstants(t *testing.T) {
	tests := []struct {
		name string
		got  CheckStatus
		want string
	}{
		{"StatusRunning", StatusRunning, "running"},
		{"StatusStopped", StatusStopped, "stopped"},
		{"StatusNotFound", StatusNotFound, "not_found"},
		{"StatusError", StatusError, "error"},
	}

	for _, tt := range tests {
		if tt.got != tt.want {
			t.Errorf("%s = %q, want %q", tt.name, tt.got, tt.want)
		}
	}
}

func TestMonitorConfigJSON(t *testing.T) {
	cfg := MonitorConfig{
		CheckIntervalSeconds: 30,
		Watches: []WatchConfig{
			{
				WatchType:                     WatchTypeService,
				Name:                          "nginx",
				AlertOnStop:                   true,
				AlertAfterConsecutiveFailures: 3,
				AutoRestart:                   true,
				MaxRestartAttempts:            5,
				RestartCooldownSeconds:        60,
			},
			{
				WatchType:                WatchTypeProcess,
				Name:                     "node",
				CpuThresholdPercent:      80.5,
				MemoryThresholdMb:        512.0,
				ThresholdDurationSeconds: 120,
			},
		},
	}

	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	var decoded MonitorConfig
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}

	if decoded.CheckIntervalSeconds != 30 {
		t.Errorf("CheckIntervalSeconds = %d, want 30", decoded.CheckIntervalSeconds)
	}
	if len(decoded.Watches) != 2 {
		t.Fatalf("len(Watches) = %d, want 2", len(decoded.Watches))
	}

	svc := decoded.Watches[0]
	if svc.WatchType != WatchTypeService {
		t.Errorf("Watches[0].WatchType = %q, want %q", svc.WatchType, WatchTypeService)
	}
	if svc.Name != "nginx" {
		t.Errorf("Watches[0].Name = %q, want %q", svc.Name, "nginx")
	}
	if !svc.AlertOnStop {
		t.Error("Watches[0].AlertOnStop = false, want true")
	}
	if svc.AlertAfterConsecutiveFailures != 3 {
		t.Errorf("Watches[0].AlertAfterConsecutiveFailures = %d, want 3", svc.AlertAfterConsecutiveFailures)
	}
	if svc.MaxRestartAttempts != 5 {
		t.Errorf("Watches[0].MaxRestartAttempts = %d, want 5", svc.MaxRestartAttempts)
	}

	proc := decoded.Watches[1]
	if proc.CpuThresholdPercent != 80.5 {
		t.Errorf("Watches[1].CpuThresholdPercent = %f, want 80.5", proc.CpuThresholdPercent)
	}
	if proc.MemoryThresholdMb != 512.0 {
		t.Errorf("Watches[1].MemoryThresholdMb = %f, want 512.0", proc.MemoryThresholdMb)
	}
}

func TestMonitorConfigJSONSnakeCase(t *testing.T) {
	raw := `{
		"check_interval_seconds": 60,
		"watches": [
			{
				"watch_type": "service",
				"name": "sshd",
				"alert_on_stop": true,
				"alert_after_consecutive_failures": 5,
				"auto_restart": false,
				"max_restart_attempts": 0,
				"restart_cooldown_seconds": 0,
				"cpu_threshold_percent": 0,
				"memory_threshold_mb": 0,
				"threshold_duration_seconds": 0
			}
		]
	}`

	var cfg MonitorConfig
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		t.Fatalf("Unmarshal from snake_case JSON failed: %v", err)
	}

	if cfg.CheckIntervalSeconds != 60 {
		t.Errorf("CheckIntervalSeconds = %d, want 60", cfg.CheckIntervalSeconds)
	}
	if len(cfg.Watches) != 1 {
		t.Fatalf("len(Watches) = %d, want 1", len(cfg.Watches))
	}
	if cfg.Watches[0].Name != "sshd" {
		t.Errorf("Watches[0].Name = %q, want %q", cfg.Watches[0].Name, "sshd")
	}
	if !cfg.Watches[0].AlertOnStop {
		t.Error("Watches[0].AlertOnStop = false, want true")
	}
	if cfg.Watches[0].AlertAfterConsecutiveFailures != 5 {
		t.Errorf("AlertAfterConsecutiveFailures = %d, want 5", cfg.Watches[0].AlertAfterConsecutiveFailures)
	}
}

func TestCheckResultJSONCamelCase(t *testing.T) {
	succeeded := true
	result := CheckResult{
		WatchType:            WatchTypeProcess,
		Name:                 "nginx",
		Status:               StatusRunning,
		CpuPercent:           45.2,
		MemoryMb:             128.5,
		Pid:                  1234,
		Details:              map[string]any{"uptime": "3h"},
		AutoRestartAttempted: true,
		AutoRestartSucceeded: &succeeded,
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal to map failed: %v", err)
	}

	// Verify camelCase field names in output
	camelKeys := []string{"watchType", "name", "status", "cpuPercent", "memoryMb", "pid", "details", "autoRestartAttempted", "autoRestartSucceeded"}
	for _, key := range camelKeys {
		if _, ok := raw[key]; !ok {
			t.Errorf("expected camelCase key %q in JSON output", key)
		}
	}
}

func TestCheckResultOmitEmpty(t *testing.T) {
	result := CheckResult{
		WatchType: WatchTypeService,
		Name:      "sshd",
		Status:    StatusRunning,
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal to map failed: %v", err)
	}

	// These should be omitted when zero/nil
	omittedKeys := []string{"cpuPercent", "memoryMb", "pid", "details", "autoRestartAttempted", "autoRestartSucceeded"}
	for _, key := range omittedKeys {
		if _, ok := raw[key]; ok {
			t.Errorf("expected key %q to be omitted when zero/nil, but found in JSON", key)
		}
	}
}

func TestCheckResultAutoRestartSucceededNilVsFalse(t *testing.T) {
	// nil means auto-restart was not attempted; false means it was attempted but failed
	resultNil := CheckResult{
		WatchType:            WatchTypeService,
		Name:                 "test",
		Status:               StatusStopped,
		AutoRestartSucceeded: nil,
	}

	dataNil, _ := json.Marshal(resultNil)
	var rawNil map[string]any
	json.Unmarshal(dataNil, &rawNil)

	if _, ok := rawNil["autoRestartSucceeded"]; ok {
		t.Error("nil AutoRestartSucceeded should be omitted from JSON")
	}

	f := false
	resultFalse := CheckResult{
		WatchType:            WatchTypeService,
		Name:                 "test",
		Status:               StatusStopped,
		AutoRestartSucceeded: &f,
	}

	dataFalse, _ := json.Marshal(resultFalse)
	var rawFalse map[string]any
	json.Unmarshal(dataFalse, &rawFalse)

	if _, ok := rawFalse["autoRestartSucceeded"]; !ok {
		t.Error("false *bool AutoRestartSucceeded should be present in JSON")
	}
}

func TestMonitorConfigEmptyWatches(t *testing.T) {
	raw := `{"check_interval_seconds": 30, "watches": []}`

	var cfg MonitorConfig
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}

	if cfg.CheckIntervalSeconds != 30 {
		t.Errorf("CheckIntervalSeconds = %d, want 30", cfg.CheckIntervalSeconds)
	}
	if len(cfg.Watches) != 0 {
		t.Errorf("len(Watches) = %d, want 0", len(cfg.Watches))
	}
}

func TestMonitorConfigNullWatches(t *testing.T) {
	raw := `{"check_interval_seconds": 30}`

	var cfg MonitorConfig
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}

	if cfg.Watches != nil {
		t.Errorf("Watches = %v, want nil for missing field", cfg.Watches)
	}
}
