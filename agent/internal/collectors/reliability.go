package collectors

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/host"
)

// ReliabilityMetrics is the payload sent to the API reliability ingestion endpoint.
type ReliabilityMetrics struct {
	UptimeSeconds   int64            `json:"uptimeSeconds"`
	BootTime        time.Time        `json:"bootTime"`
	CrashEvents     []CrashEvent     `json:"crashEvents"`
	AppHangs        []AppHang        `json:"appHangs"`
	ServiceFailures []ServiceFailure `json:"serviceFailures"`
	HardwareErrors  []HardwareError  `json:"hardwareErrors"`
}

type CrashEvent struct {
	Type      string         `json:"type"`
	Timestamp time.Time      `json:"timestamp"`
	Details   map[string]any `json:"details,omitempty"`
}

type AppHang struct {
	ProcessName string    `json:"processName"`
	Timestamp   time.Time `json:"timestamp"`
	Duration    int       `json:"duration"` // seconds
	Resolved    bool      `json:"resolved"`
}

type ServiceFailure struct {
	ServiceName string    `json:"serviceName"`
	Timestamp   time.Time `json:"timestamp"`
	ErrorCode   string    `json:"errorCode,omitempty"`
	Recovered   bool      `json:"recovered"`
}

type HardwareError struct {
	Type      string    `json:"type"`
	Severity  string    `json:"severity"`
	Timestamp time.Time `json:"timestamp"`
	Source    string    `json:"source"`
	EventID   string    `json:"eventId,omitempty"`
}

// ReliabilityCollector derives reliability metrics from uptime and event telemetry.
type ReliabilityCollector struct {
	mu          sync.Mutex
	eventLogCol *EventLogCollector
}

const reliabilityInitialLookback = 24 * time.Hour

func NewReliabilityCollector() *ReliabilityCollector {
	eventCollector := NewEventLogCollector()
	// Start reliability collection with a lookback window so first upload
	// includes recent crash/failure signals instead of only new events.
	eventCollector.lastCollectTime = time.Now().Add(-reliabilityInitialLookback)

	return &ReliabilityCollector{
		eventLogCol: eventCollector,
	}
}

func (c *ReliabilityCollector) collectBase() (*ReliabilityMetrics, error) {
	info, err := host.Info()
	if err != nil {
		return nil, fmt.Errorf("failed to collect host info: %w", err)
	}

	return &ReliabilityMetrics{
		UptimeSeconds:   int64(info.Uptime),
		BootTime:        time.Unix(int64(info.BootTime), 0).UTC(),
		CrashEvents:     []CrashEvent{},
		AppHangs:        []AppHang{},
		ServiceFailures: []ServiceFailure{},
		HardwareErrors:  []HardwareError{},
	}, nil
}

func normalizeEventTimestamp(value string) time.Time {
	if value == "" {
		return time.Now().UTC()
	}
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		return parsed.UTC()
	}
	if parsed, err := time.Parse("2006-01-02 15:04:05.000", value); err == nil {
		return parsed.UTC()
	}
	if parsed, err := time.Parse("2006-01-02 15:04:05", value); err == nil {
		return parsed.UTC()
	}
	return time.Now().UTC()
}

func severityFromLevel(level string) string {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "critical":
		return "critical"
	case "error":
		return "error"
	default:
		return "warning"
	}
}

func classifyHardwareType(message, source, eventID string) string {
	msg := strings.ToLower(message)
	src := strings.ToLower(source)
	eid := strings.ToLower(eventID)
	switch {
	case strings.Contains(src, "whea"), strings.Contains(msg, "machine check"), strings.Contains(msg, "mce"):
		return "mce"
	case strings.Contains(msg, "memory"), strings.Contains(msg, "edac"),
		eid == "13" || eid == "50" || eid == "51":
		return "memory"
	case strings.Contains(msg, "disk"), strings.Contains(msg, "i/o"), strings.Contains(msg, "blk_update_request"),
		eid == "7" || eid == "11" || eid == "15":
		return "disk"
	default:
		return "unknown"
	}
}

func appendCrash(metrics *ReliabilityMetrics, eventType string, ts time.Time, details map[string]any) {
	metrics.CrashEvents = append(metrics.CrashEvents, CrashEvent{
		Type:      eventType,
		Timestamp: ts,
		Details:   details,
	})
}

func appendHang(metrics *ReliabilityMetrics, processName string, ts time.Time) {
	if processName == "" {
		processName = "unknown"
	}
	metrics.AppHangs = append(metrics.AppHangs, AppHang{
		ProcessName: processName,
		Timestamp:   ts,
		Duration:    0,
		Resolved:    false,
	})
}

func appendServiceFailure(metrics *ReliabilityMetrics, serviceName string, ts time.Time, eventID string) {
	if serviceName == "" {
		serviceName = "unknown"
	}
	metrics.ServiceFailures = append(metrics.ServiceFailures, ServiceFailure{
		ServiceName: serviceName,
		Timestamp:   ts,
		ErrorCode:   eventID,
		Recovered:   false,
	})
}

func appendHardwareError(metrics *ReliabilityMetrics, entry EventLogEntry, ts time.Time) {
	metrics.HardwareErrors = append(metrics.HardwareErrors, HardwareError{
		Type:      classifyHardwareType(entry.Message, entry.Source, entry.EventID),
		Severity:  severityFromLevel(entry.Level),
		Timestamp: ts,
		Source:    entry.Source,
		EventID:   entry.EventID,
	})
}
