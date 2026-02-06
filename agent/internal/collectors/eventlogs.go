package collectors

import (
	"sync"
	"time"
)

// EventLogEntry represents a single event log entry (platform-agnostic)
type EventLogEntry struct {
	Timestamp string         `json:"timestamp"`
	Level     string         `json:"level"`    // "info", "warning", "error", "critical"
	Category  string         `json:"category"` // "security", "hardware", "application", "system"
	Source    string         `json:"source"`
	EventID   string         `json:"eventId"`
	Message   string         `json:"message"`
	Details   map[string]any `json:"details,omitempty"`
}

// EventLogCollector collects OS event logs on a per-platform basis
type EventLogCollector struct {
	mu              sync.Mutex
	lastCollectTime time.Time
	maxEvents       int
}

// NewEventLogCollector creates a new EventLogCollector
func NewEventLogCollector() *EventLogCollector {
	return &EventLogCollector{
		lastCollectTime: time.Now(),
		maxEvents:       100,
	}
}
