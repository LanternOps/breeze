package collectors

import (
	"fmt"
	"regexp"
	"strconv"
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

// classifyHardwareType returns a hardware error category string.
// numericID is the parsed integer event ID (pass numericEventID(entry) before calling).
// Returns "unknown" when the event does not match a known hardware signal.
//
// Bare numeric event IDs are only meaningful per-provider: 13/50/51 (memory) and
// 7/11/15 (disk) are hardware signals when emitted by disk/ntfs/volmgr-class
// sources, but software providers reuse the same IDs — VSS logs event 13, which
// an unconditional ID match turned into a "memory" hardware error. ID-only
// matches therefore require a known hardware source; message signals stand alone.
func classifyHardwareType(message, source string, numericID int) string {
	msg := strings.ToLower(message)
	src := strings.ToLower(source)
	hwSrc := isHardwareSource(src)
	switch {
	case strings.Contains(src, "whea"), strings.Contains(msg, "machine check"), strings.Contains(msg, "mce"):
		return "mce"
	case strings.Contains(msg, "thermal"):
		// macOS thermal-pressure / SMC thermal faults. Stamped as a real type so
		// the API's genuine-hardware gate recognises it by type, not by hoping the
		// substring "thermal" appears in the source.
		return "thermal"
	case strings.Contains(msg, "memory"), strings.Contains(msg, "edac"),
		hwSrc && (numericID == 13 || numericID == 50 || numericID == 51):
		return "memory"
	case strings.Contains(msg, "disk"), strings.Contains(msg, "i/o"), strings.Contains(msg, "blk_update_request"),
		hwSrc && (numericID == 7 || numericID == 11 || numericID == 15):
		return "disk"
	default:
		return "unknown"
	}
}

// numericEventID extracts the numeric event ID from an EventLogEntry.
// It first checks Details["eventId"] (set as an int by all Windows collectors),
// then falls back to parsing the integer prefix of EventID ("id:recordId").
func numericEventID(entry EventLogEntry) int {
	if v, ok := entry.Details["eventId"]; ok {
		switch n := v.(type) {
		case int:
			return n
		case int64:
			return int(n)
		case float64:
			return int(n)
		}
	}
	// Fall back: parse integer prefix before the first ':'
	raw := entry.EventID
	if idx := strings.IndexByte(raw, ':'); idx >= 0 {
		raw = raw[:idx]
	}
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	return n
}

// reServiceName extracts the failing service name from SCM messages like
// "The <ServiceName> service terminated unexpectedly".
var reServiceName = regexp.MustCompile(`(?i)the (.+?) service\b`)

// parseServiceName extracts the service name from an SCM message.
// Falls back to fallback (typically entry.Source) if no match.
func parseServiceName(message, fallback string) string {
	if m := reServiceName.FindStringSubmatch(message); len(m) >= 2 {
		name := strings.TrimSpace(m[1])
		if name != "" {
			return name
		}
	}
	return fallback
}

// knownHardwareSources lists provider name substrings that always indicate a
// genuine hardware/driver event, even when classifyHardwareType returns "unknown".
var knownHardwareSources = []string{
	"whea", "disk", "ntfs", "volmgr", "storahci", "stornvme",
	"nvme", "iastor", "msahci", "nvlddmkm", "amdkmdag", "igfx",
}

// isHardwareSource returns true when the source (lowercased) matches a known
// hardware/driver provider name.
func isHardwareSource(srcLower string) bool {
	for _, kw := range knownHardwareSources {
		if strings.Contains(srcLower, kw) {
			return true
		}
	}
	return false
}

// scmFailureEventIDs is the set of Service Control Manager event IDs that
// represent genuine service failures (start failure, crash, exit, etc.).
// 7036 (state-change), 7040 (start-type change), 7045 (service installed) are
// routine and are intentionally excluded.
var scmFailureEventIDs = map[int]bool{
	7000: true, // service failed to start
	7022: true, // service hung on start
	7023: true, // service terminated with error
	7024: true, // service terminated with service-specific error
	7026: true, // boot/system start driver failed to load
	7031: true, // service terminated unexpectedly
	7034: true, // service terminated unexpectedly (no recovery configured)
}

// eventLogName returns the Windows log a collected event came from
// (Details["logName"], set by every Windows collector — "System", "Application",
// "Security"). Empty when unknown. Used to keep the EventID-1001 crash branch
// scoped to the System log: a System-log 1001 is a BugCheck/BSOD report, whereas
// an Application-log 1001 ("Windows Error Reporting") is a routine per-app
// APPCRASH/APPHANG and must NOT inflate the kernel-crash factor.
func eventLogName(entry EventLogEntry) string {
	if v, ok := entry.Details["logName"]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// classifyEventLogEntry routes a single event log entry into exactly one
// reliability factor (crash / service-failure / hang / hardware-error) or none.
// Priority order: crash → service → hang → hardware.
// Each event goes to AT MOST ONE factor; no double-counting.
//
// Platform-neutral (no build tag) so it is unit-testable on Linux CI.
func classifyEventLogEntry(metrics *ReliabilityMetrics, entry EventLogEntry) {
	ts := normalizeEventTimestamp(entry.Timestamp)
	msg := strings.ToLower(entry.Message)
	src := strings.ToLower(entry.Source)
	nid := numericEventID(entry)

	// ── 1. Crash ─────────────────────────────────────────────────────────────
	switch {
	case strings.Contains(msg, "bugcheck"), strings.Contains(msg, "blue screen"),
		strings.Contains(msg, "bluescreen"): // WER BSOD reports say "Event Name: BlueScreen" (no space)
		appendCrash(metrics, "bsod", ts, map[string]any{
			"source":  entry.Source,
			"eventId": entry.EventID,
			"level":   entry.Level,
		})
		return

	case strings.Contains(msg, "kernel panic"):
		appendCrash(metrics, "kernel_panic", ts, map[string]any{
			"source":  entry.Source,
			"eventId": entry.EventID,
		})
		return

	case nid == 41: // Kernel-Power: unexpected power loss / bugcheck
		appendCrash(metrics, "bsod", ts, map[string]any{
			"source":  entry.Source,
			"eventId": entry.EventID,
			"level":   entry.Level,
		})
		return

	case nid == 1001 && strings.EqualFold(eventLogName(entry), "System"):
		// System-log 1001 is a BugCheck/BSOD report. Gating on the System log (not
		// just a "WER-ish" source name) excludes Application-log "Windows Error
		// Reporting" 1001 APPCRASH/APPHANG, which would otherwise inflate crashes.
		// (DCOM 10010 never reaches here: matched by EQUALITY on 1001, not substring.)
		appendCrash(metrics, "bsod", ts, map[string]any{
			"source":  entry.Source,
			"eventId": entry.EventID,
			"level":   entry.Level,
		})
		return

	case nid == 6008: // Unexpected shutdown (previous boot)
		appendCrash(metrics, "bsod", ts, map[string]any{
			"source":  entry.Source,
			"eventId": entry.EventID,
			"level":   entry.Level,
		})
		return

	case strings.Contains(msg, "unexpected shutdown"):
		appendCrash(metrics, "bsod", ts, map[string]any{
			"source":  entry.Source,
			"eventId": entry.EventID,
			"level":   entry.Level,
		})
		return
	}

	// ── 2. Service failure ────────────────────────────────────────────────────
	isScm := strings.Contains(src, "service control manager")
	if isScm && scmFailureEventIDs[nid] {
		svcName := parseServiceName(entry.Message, entry.Source)
		appendServiceFailure(metrics, svcName, ts, entry.EventID)
		return
	}
	// Secondary: message-based fallback (non-SCM sources that talk about service failures)
	if !isScm && strings.Contains(msg, "service") &&
		(strings.Contains(msg, "terminated") || strings.Contains(msg, "failed to start")) {
		svcName := parseServiceName(entry.Message, entry.Source)
		appendServiceFailure(metrics, svcName, ts, entry.EventID)
		return
	}

	// ── 3. Hang ───────────────────────────────────────────────────────────────
	if strings.Contains(msg, "hang") || strings.Contains(msg, "not responding") ||
		strings.Contains(src, "application hang") || nid == 1002 {
		appendHang(metrics, entry.Source, ts)
		return
	}

	// ── 4. Hardware error ─────────────────────────────────────────────────────
	// Gate on genuine hardware signals only — NOT on entry.Category.
	if classifyHardwareType(entry.Message, entry.Source, nid) != "unknown" || isHardwareSource(src) {
		appendHardwareError(metrics, entry, ts)
		return
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
		Type:      classifyHardwareType(entry.Message, entry.Source, numericEventID(entry)),
		Severity:  severityFromLevel(entry.Level),
		Timestamp: ts,
		Source:    entry.Source,
		EventID:   entry.EventID,
	})
}
