package monitoring

// MonitorConfig is the agent-side representation of the monitoring policy
// received via heartbeat configUpdate.
type MonitorConfig struct {
	CheckIntervalSeconds int           `json:"check_interval_seconds"`
	Watches              []WatchConfig `json:"watches"`
}

// WatchConfig describes a single service or process to monitor.
type WatchConfig struct {
	WatchType                     string  `json:"watch_type"` // "service" or "process"
	Name                          string  `json:"name"`
	AlertOnStop                   bool    `json:"alert_on_stop"`
	AlertAfterConsecutiveFailures int     `json:"alert_after_consecutive_failures"`
	AutoRestart                   bool    `json:"auto_restart"`
	MaxRestartAttempts            int     `json:"max_restart_attempts"`
	RestartCooldownSeconds        int     `json:"restart_cooldown_seconds"`
	CpuThresholdPercent           float64 `json:"cpu_threshold_percent,omitempty"`
	MemoryThresholdMb             float64 `json:"memory_threshold_mb,omitempty"`
	ThresholdDurationSeconds      int     `json:"threshold_duration_seconds,omitempty"`
}

// CheckResult is sent back to the API for each watch item.
type CheckResult struct {
	WatchType            string         `json:"watchType"`
	Name                 string         `json:"name"`
	Status               string         `json:"status"` // running, stopped, not_found, error
	CpuPercent           float64        `json:"cpuPercent,omitempty"`
	MemoryMb             float64        `json:"memoryMb,omitempty"`
	Pid                  int            `json:"pid,omitempty"`
	Details              map[string]any `json:"details,omitempty"`
	AutoRestartAttempted bool           `json:"autoRestartAttempted,omitempty"`
	AutoRestartSucceeded bool           `json:"autoRestartSucceeded,omitempty"`
}
