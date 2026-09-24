package hwhealth

import "time"

type Kind string

type Tier string

type ComponentType string

type SourceStatus string

const (
	TierRAID Tier = "raid"
	TierDisk Tier = "disk"
)

type Component struct {
	ComponentKey      string         `json:"componentKey"`
	ComponentType     ComponentType  `json:"componentType"`
	ParentKey         *string        `json:"parentKey,omitempty"`
	Source            Kind           `json:"source"`
	Name              string         `json:"name"`
	Model             *string        `json:"model,omitempty"`
	Serial            *string        `json:"serial,omitempty"`
	Firmware          *string        `json:"firmware,omitempty"`
	SizeBytes         *int64         `json:"sizeBytes,omitempty"`
	State             string         `json:"state"`
	StateDetail       *string        `json:"stateDetail,omitempty"`
	ProgressPercent   *int           `json:"progressPercent,omitempty"`
	TemperatureC      *int           `json:"temperatureC,omitempty"`
	PredictiveFailure bool           `json:"predictiveFailure"`
	AlertExempt       bool           `json:"alertExempt"`
	MemberErrors      *bool          `json:"memberErrors,omitempty"`
	OSHealthStatus    *string        `json:"osHealthStatus,omitempty"`
	SmartPassed       *bool          `json:"smartPassed,omitempty"`
	Attributes        map[string]any `json:"attributes"`
}

type SourceReport struct {
	Source      Kind         `json:"source"`
	Status      SourceStatus `json:"status"`
	Complete    *bool        `json:"complete,omitempty"`
	ToolVersion string       `json:"toolVersion,omitempty"`
	Path        string       `json:"path,omitempty"`
	DurationMs  int64        `json:"durationMs,omitempty"`
	Error       string       `json:"error,omitempty"`
	RetryAt     *time.Time   `json:"retryAt,omitempty"`
	Warnings    []string     `json:"warnings,omitempty"`
}

type Snapshot struct {
	SnapshotID                string         `json:"snapshotId"`
	Sequence                  uint64         `json:"sequence"`
	CollectedAt               time.Time      `json:"collectedAt"`
	AgentVersion              string         `json:"agentVersion"`
	PollIntervalMinutes       int            `json:"pollIntervalMinutes"`
	DiskHealthIntervalMinutes int            `json:"diskHealthIntervalMinutes"`
	TiersRun                  []string       `json:"tiersRun"`
	Sources                   []SourceReport `json:"sources"`
	Components                []Component    `json:"components"`
}

type Config struct {
	Enabled            bool
	PollInterval       time.Duration
	DiskHealthInterval time.Duration
}

func ptr[T any](v T) *T { return &v }
