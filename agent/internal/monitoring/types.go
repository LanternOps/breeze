package monitoring

// WatchType represents the kind of item being monitored.
type WatchType = string

const (
	WatchTypeService WatchType = "service"
	WatchTypeProcess WatchType = "process"
)

// CheckStatus represents the result status of a monitoring check.
type CheckStatus = string

const (
	StatusRunning  CheckStatus = "running"
	StatusStopped  CheckStatus = "stopped"
	StatusNotFound CheckStatus = "not_found"
	StatusError    CheckStatus = "error"
)

// MonitorConfig is the agent-side representation of the monitoring policy
// received via heartbeat configUpdate. The heartbeat response delivers this
// under the key "monitoring_settings" (or camelCase variant "monitoringSettings").
//
// JSON field names use snake_case to match the API wire format;
// CheckResult uses camelCase to match the API's ingest endpoint.
type MonitorConfig struct {
	CheckIntervalSeconds int           `json:"check_interval_seconds"`
	Watches              []WatchConfig `json:"watches"`
}

// WatchConfig describes a single service or process to monitor.
type WatchConfig struct {
	WatchType                     WatchType `json:"watch_type"`
	Name                          string    `json:"name"`
	AlertOnStop                   bool      `json:"alert_on_stop"`
	AlertAfterConsecutiveFailures int       `json:"alert_after_consecutive_failures"`
	AutoRestart                   bool      `json:"auto_restart"`
	MaxRestartAttempts            int       `json:"max_restart_attempts"`
	RestartCooldownSeconds        int       `json:"restart_cooldown_seconds"`
	CpuThresholdPercent           float64   `json:"cpu_threshold_percent,omitempty"`
	MemoryThresholdMb             float64   `json:"memory_threshold_mb,omitempty"`
	ThresholdDurationSeconds      int       `json:"threshold_duration_seconds,omitempty"`
}

// CheckResult is sent back to the API for each watch item.
type CheckResult struct {
	WatchType            WatchType      `json:"watchType"`
	Name                 string         `json:"name"`
	Status               CheckStatus    `json:"status"`
	CpuPercent           float64        `json:"cpuPercent,omitempty"`
	MemoryMb             float64        `json:"memoryMb,omitempty"`
	Pid                  int            `json:"pid,omitempty"`
	Details              map[string]any `json:"details,omitempty"`
	AutoRestartAttempted bool           `json:"autoRestartAttempted,omitempty"`
	AutoRestartSucceeded *bool          `json:"autoRestartSucceeded,omitempty"`
}
