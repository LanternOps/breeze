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

// validCategories defines the set of recognized event log categories.
var validCategories = map[string]bool{
	"security": true, "hardware": true,
	"application": true, "system": true,
}

// levelOrder maps level strings to numeric order for comparison
var levelOrder = map[string]int{
	"info":     0,
	"warning":  1,
	"error":    2,
	"critical": 3,
}

// EventLogCollector collects OS event logs on a per-platform basis
type EventLogCollector struct {
	mu              sync.Mutex
	lastCollectTime time.Time
	maxEvents       int
	categories      []string
	minimumLevel    string
	intervalMinutes int
}

// NewEventLogCollector creates a new EventLogCollector
func NewEventLogCollector() *EventLogCollector {
	return &EventLogCollector{
		lastCollectTime: time.Now(),
		maxEvents:       100,
		categories:      []string{"security", "hardware", "application", "system"},
		minimumLevel:    "info",
		intervalMinutes: 5,
	}
}

// UpdateConfig updates the collector settings. Thread-safe via mutex.
func (c *EventLogCollector) UpdateConfig(maxEvents int, categories []string, minimumLevel string, intervalMinutes int) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if maxEvents >= 10 && maxEvents <= 500 {
		c.maxEvents = maxEvents
	}
	if len(categories) > 0 {
		var valid []string
		for _, cat := range categories {
			if validCategories[cat] {
				valid = append(valid, cat)
			}
		}
		if len(valid) > 0 {
			c.categories = valid
		}
	}
	if _, ok := levelOrder[minimumLevel]; ok {
		c.minimumLevel = minimumLevel
	}
	if intervalMinutes >= 1 && intervalMinutes <= 60 {
		c.intervalMinutes = intervalMinutes
	}
}

// IntervalMinutes returns the configured collection interval.
func (c *EventLogCollector) IntervalMinutes() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.intervalMinutes
}

// Categories returns the configured categories to collect.
func (c *EventLogCollector) Categories() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	result := make([]string, len(c.categories))
	copy(result, c.categories)
	return result
}

// readConfig reads categories, minimumLevel, and maxEvents under lock.
func (c *EventLogCollector) readConfig() (categories []string, minLevel string, maxEvents int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cats := make([]string, len(c.categories))
	copy(cats, c.categories)
	return cats, c.minimumLevel, c.maxEvents
}

// categoryEnabled returns true if the given category is in the enabled list.
func categoryEnabled(categories []string, category string) bool {
	for _, c := range categories {
		if c == category {
			return true
		}
	}
	return false
}

// filterByLevel removes entries below the minimum level threshold.
func filterByLevel(events []EventLogEntry, minLevel string) []EventLogEntry {
	threshold, ok := levelOrder[minLevel]
	if !ok || threshold == 0 {
		return events // "info" or unknown means keep all
	}
	filtered := make([]EventLogEntry, 0, len(events))
	for _, e := range events {
		if levelOrder[e.Level] >= threshold {
			filtered = append(filtered, e)
		}
	}
	return filtered
}
