package monitoring

import (
	"encoding/json"
	"testing"
)

// The `monitoring_settings` wire shape is FROZEN by #5287 W04 (#5291).
//
// W04 changed where the API sources service/process watches from — the device's
// effective MONITOR set first, the config-policy Monitoring tab second — without
// changing one byte of what goes on the wire. This test is the agent-side half
// of that guarantee: the API asserts the emitted key set in
// apps/api/src/routes/agents/helpers.monitorWatchDelivery.test.ts, and this
// parses the identical literal payload back into MonitorConfig / WatchConfig.
//
// If a future wave renames or retypes a field, one of these two tests fails
// before an agent in the field silently stops watching anything.
func TestW04MonitoringSettingsWireShape(t *testing.T) {
	// Copied verbatim from the API test's expected output for the collision
	// case (a monitor-derived service watch merged with the policy tab's row)
	// plus a process watch carrying the thresholds only the policy tab authors.
	const payload = `{
	  "check_interval_seconds": 45,
	  "watches": [
	    {
	      "watch_type": "service",
	      "name": "Spooler",
	      "alert_on_stop": true,
	      "alert_after_consecutive_failures": 5,
	      "auto_restart": true,
	      "max_restart_attempts": 3,
	      "restart_cooldown_seconds": 300
	    },
	    {
	      "watch_type": "process",
	      "name": "chrome.exe",
	      "alert_on_stop": true,
	      "alert_after_consecutive_failures": 2,
	      "auto_restart": false,
	      "max_restart_attempts": 3,
	      "restart_cooldown_seconds": 300,
	      "cpu_threshold_percent": 80,
	      "memory_threshold_mb": 2048,
	      "threshold_duration_seconds": 300
	    }
	  ]
	}`

	var cfg MonitorConfig
	if err := json.Unmarshal([]byte(payload), &cfg); err != nil {
		t.Fatalf("unmarshal monitoring_settings: %v", err)
	}

	if cfg.CheckIntervalSeconds != 45 {
		t.Errorf("CheckIntervalSeconds = %d, want 45", cfg.CheckIntervalSeconds)
	}
	if len(cfg.Watches) != 2 {
		t.Fatalf("len(Watches) = %d, want 2", len(cfg.Watches))
	}

	tests := []struct {
		name string
		got  WatchConfig
		want WatchConfig
	}{
		{
			name: "service watch merged from a monitor and the policy tab",
			got:  cfg.Watches[0],
			want: WatchConfig{
				WatchType:                     WatchTypeService,
				Name:                          "Spooler",
				AlertOnStop:                   true,
				AlertAfterConsecutiveFailures: 5,
				// Never lowered by the union — this flag drives the agent's own
				// offline-capable restart (monitor_autorestart_test.go).
				AutoRestart:            true,
				MaxRestartAttempts:     3,
				RestartCooldownSeconds: 300,
			},
		},
		{
			name: "process watch keeps the policy tab's thresholds",
			got:  cfg.Watches[1],
			want: WatchConfig{
				WatchType:                     WatchTypeProcess,
				Name:                          "chrome.exe",
				AlertOnStop:                   true,
				AlertAfterConsecutiveFailures: 2,
				AutoRestart:                   false,
				MaxRestartAttempts:            3,
				RestartCooldownSeconds:        300,
				CpuThresholdPercent:           80,
				MemoryThresholdMb:             2048,
				ThresholdDurationSeconds:      300,
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.got != tc.want {
				t.Errorf("watch = %+v, want %+v", tc.got, tc.want)
			}
		})
	}
}

// A payload carrying a key this agent build does not know must still parse:
// agents in the field are older than the API, so a future additive key must
// never make an agent drop its whole monitoring config.
func TestW04MonitoringSettingsIgnoresUnknownKeys(t *testing.T) {
	const payload = `{
	  "check_interval_seconds": 60,
	  "some_future_key": {"nested": true},
	  "watches": [
	    {
	      "watch_type": "service",
	      "name": "W32Time",
	      "alert_on_stop": true,
	      "alert_after_consecutive_failures": 2,
	      "auto_restart": false,
	      "max_restart_attempts": 3,
	      "restart_cooldown_seconds": 300,
	      "some_future_watch_key": "ignored"
	    }
	  ]
	}`

	var cfg MonitorConfig
	if err := json.Unmarshal([]byte(payload), &cfg); err != nil {
		t.Fatalf("unmarshal with unknown keys: %v", err)
	}
	if len(cfg.Watches) != 1 || cfg.Watches[0].Name != "W32Time" {
		t.Fatalf("watches = %+v, want one W32Time watch", cfg.Watches)
	}
	if cfg.CheckIntervalSeconds != 60 {
		t.Errorf("CheckIntervalSeconds = %d, want 60", cfg.CheckIntervalSeconds)
	}
}
