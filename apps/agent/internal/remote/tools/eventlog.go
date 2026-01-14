// Package tools provides remote management utilities for the Breeze agent.
package tools

import (
	"sync"
	"time"
)

// EventLog represents metadata about a Windows event log.
type EventLog struct {
	Name         string `json:"name"`
	DisplayName  string `json:"displayName"`
	RecordCount  uint64 `json:"recordCount"`
	MaxSizeBytes uint64 `json:"maxSizeBytes"`
	Retention    string `json:"retention"`
}

// EventFilter specifies criteria for querying event log entries.
type EventFilter struct {
	Level     []string  `json:"level,omitempty"`    // Information, Warning, Error, Critical
	Source    string    `json:"source,omitempty"`   // Event source/provider name
	EventIDs  []uint32  `json:"eventIds,omitempty"` // Specific event IDs to include
	StartTime time.Time `json:"startTime,omitempty"`
	EndTime   time.Time `json:"endTime,omitempty"`
	Limit     int       `json:"limit,omitempty"`  // Maximum number of results
	Offset    int       `json:"offset,omitempty"` // Skip this many results (for pagination)
}

// EventLogEntry represents a single event log record.
type EventLogEntry struct {
	RecordID    uint64    `json:"recordId"`
	EventID     uint32    `json:"eventId"`
	Level       string    `json:"level"`
	Source      string    `json:"source"`
	TimeCreated time.Time `json:"timeCreated"`
	Computer    string    `json:"computer"`
	Message     string    `json:"message"`
	Category    string    `json:"category"`
	User        string    `json:"user"`
	Data        string    `json:"data,omitempty"`
}

// EventQueryResult contains paginated query results.
type EventQueryResult struct {
	Events     []EventLogEntry `json:"events"`
	TotalCount int             `json:"totalCount"`
	HasMore    bool            `json:"hasMore"`
	Offset     int             `json:"offset"`
	Limit      int             `json:"limit"`
}

// ClearLogOptions specifies options for clearing an event log.
type ClearLogOptions struct {
	BackupPath string `json:"backupPath,omitempty"` // If set, backup log before clearing
}

// EventLogManager provides access to Windows event logs.
type EventLogManager struct {
	mu sync.Mutex
}

// NewEventLogManager creates a new EventLogManager instance.
func NewEventLogManager() *EventLogManager {
	return &EventLogManager{}
}

// Event level constants matching Windows event log levels.
const (
	EventLevelCritical    = "Critical"
	EventLevelError       = "Error"
	EventLevelWarning     = "Warning"
	EventLevelInformation = "Information"
	EventLevelVerbose     = "Verbose"
)

// Default log names for Windows event logs.
var DefaultLogNames = []string{
	"Application",
	"Security",
	"Setup",
	"System",
	"ForwardedEvents",
}

// DefaultQueryLimit is the default number of events to return if not specified.
const DefaultQueryLimit = 100

// MaxQueryLimit is the maximum number of events that can be returned in a single query.
const MaxQueryLimit = 10000
