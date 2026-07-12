//go:build darwin

package collectors

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Collect gathers event logs from macOS sources in parallel
func (c *EventLogCollector) Collect() ([]EventLogEntry, error) {
	c.mu.Lock()
	lastCollect := c.lastCollectTime
	c.mu.Unlock()

	// Stamp the next window from the START of this pass, not the end: the
	// sub-collectors query up to roughly this instant, so stamping after they
	// finish would leave a gap covering the pass duration. The tiny overlap
	// this creates can at worst duplicate an event that lands mid-pass —
	// preferable to silently dropping it (there is no dedup downstream).
	passStart := time.Now()

	categories, minLevel, maxEvents := c.readConfig()

	securityEnabled := categoryEnabled(categories, "security")
	hardwareEnabled := categoryEnabled(categories, "hardware")

	var subCollectors []func(since time.Time) ([]EventLogEntry, error)
	if securityEnabled || hardwareEnabled {
		// security + hardware share ONE `log show` invocation (issue #2390:
		// two parallel queries doubled seconds of CPU per pass for the same data).
		subCollectors = append(subCollectors, func(since time.Time) ([]EventLogEntry, error) {
			return c.collectUnifiedLogEvents(since, securityEnabled, hardwareEnabled)
		})
	}
	if categoryEnabled(categories, "application") {
		subCollectors = append(subCollectors, c.collectCrashReports)
	}
	if categoryEnabled(categories, "system") {
		subCollectors = append(subCollectors, c.collectPowerEvents)
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	var allEvents []EventLogEntry

	wg.Add(len(subCollectors))
	for _, fn := range subCollectors {
		go func(f func(since time.Time) ([]EventLogEntry, error)) {
			defer wg.Done()
			events, err := f(lastCollect)
			if err != nil {
				slog.Warn("event log sub-collector error", "error", err.Error())
				return
			}
			mu.Lock()
			allEvents = append(allEvents, events...)
			mu.Unlock()
		}(fn)
	}
	wg.Wait()

	c.mu.Lock()
	c.lastCollectTime = passStart
	c.mu.Unlock()

	// Filter by minimum level
	allEvents = filterByLevel(allEvents, minLevel)

	// Cap to maxEvents
	if len(allEvents) > maxEvents {
		allEvents = allEvents[:maxEvents]
	}

	return allEvents, nil
}

// unifiedLogEntry matches the JSON output of `log show --style json`
type unifiedLogEntry struct {
	Timestamp        string `json:"timestamp"`
	Subsystem        string `json:"subsystem"`
	Category         string `json:"category"`
	EventMessage     string `json:"eventMessage"`
	MessageType      string `json:"messageType"` // Default, Info, Debug, Error, Fault
	ProcessImagePath string `json:"processImagePath"`
	ProcessID        int    `json:"processID"`
}

// unifiedLogStartFormat is the "YYYY-MM-DD HH:MM:SSZZZZZ" form accepted by
// `log show --start` (see log(1)).
const unifiedLogStartFormat = "2006-01-02 15:04:05-0700"

// collectUnifiedLogEvents gathers security events (auth failures, TCC changes)
// and hardware errors (disk, thermal, kernel) from the unified log in a single
// `log show` invocation, re-categorizing each entry in Go. Querying the
// unified log costs seconds of CPU regardless of how little it returns
// (issue #2390), so the two categories must never fan out as separate queries.
func (c *EventLogCollector) collectUnifiedLogEvents(since time.Time, securityEnabled, hardwareEnabled bool) ([]EventLogEntry, error) {
	predicate := buildUnifiedLogPredicate(securityEnabled, hardwareEnabled)
	if predicate == "" {
		return nil, nil
	}

	start := unifiedLogQueryStart(since, time.Now())

	// runCollectorBoundedOutput streams stdout through an io.LimitReader so the
	// 4 MiB cap is enforced before the bytes are buffered (the old
	// runCollectorOutput buffered everything first and checked post-hoc).
	output, err := runCollectorBoundedOutput(collectorLongCommandTimeout, "log", "show",
		"--predicate", predicate,
		"--style", "json",
		"--start", start.Format(unifiedLogStartFormat),
	)
	if err != nil {
		return nil, fmt.Errorf("log show failed: %w", err)
	}

	if len(output) == 0 {
		return nil, nil
	}

	var entries []unifiedLogEntry
	if err := json.Unmarshal(output, &entries); err != nil {
		return nil, fmt.Errorf("failed to parse log output: %w", err)
	}

	var results []EventLogEntry
	for _, e := range entries {
		level := mapUnifiedLevel(e.MessageType)
		// Only include error/fault level by default
		if level != "error" && level != "critical" {
			continue
		}

		source := e.Subsystem
		if source == "" {
			source = filepath.Base(e.ProcessImagePath)
		}

		results = append(results, EventLogEntry{
			Timestamp: e.Timestamp,
			Level:     level,
			Category:  classifyUnifiedLogCategory(e.Subsystem, e.EventMessage, securityEnabled, hardwareEnabled),
			Source:    truncateCollectorString(source),
			EventID:   truncateCollectorString(fmt.Sprintf("%s:%d", source, e.ProcessID)),
			Message:   truncateString(e.EventMessage, 500),
			Details: map[string]any{
				"subsystem":   truncateCollectorString(e.Subsystem),
				"processId":   e.ProcessID,
				"logCategory": e.Category,
			},
		})
		if len(results) >= collectorResultLimit {
			break
		}
	}

	return results, nil
}

// collectCrashReports scans DiagnosticReports for new .ips files
func (c *EventLogCollector) collectCrashReports(since time.Time) ([]EventLogEntry, error) {
	dirs := []string{
		filepath.Join(os.Getenv("HOME"), "Library/Logs/DiagnosticReports"),
		"/Library/Logs/DiagnosticReports",
	}

	var results []EventLogEntry

	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue // dir may not exist
		}

		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}

			name := entry.Name()
			if !strings.HasSuffix(name, ".ips") && !strings.HasSuffix(name, ".crash") {
				continue
			}

			info, err := entry.Info()
			if err != nil {
				continue
			}

			if info.ModTime().Before(since) {
				continue
			}

			fullPath := filepath.Join(dir, name)
			crashData, err := parseCrashReport(fullPath)
			if err != nil {
				continue
			}

			// Classify from the authoritative .ips bug_type (filename/procName are
			// fallbacks). Real kernel panics are labelled "Kernel panic" so the
			// reliability classifier counts them as a full device crash; per-app
			// reports become "Application crash" (the classifier counts those as a
			// weak, downweighted app_crash); JetsamEvent memory-pressure reports
			// are labelled distinctly and dropped by the classifier.
			kind := crashReportKind(name, crashData.bugType, crashData.processName)

			results = append(results, EventLogEntry{
				Timestamp: info.ModTime().UTC().Format(time.RFC3339),
				Level:     "error",
				Category:  "application",
				Source:    crashData.processName,
				EventID:   fmt.Sprintf("crash:%s", name),
				Message:   fmt.Sprintf("%s: %s (%s)", kind, crashData.processName, crashData.exceptionType),
				Details: map[string]any{
					"file":          name,
					"processName":   crashData.processName,
					"exceptionType": crashData.exceptionType,
					"version":       crashData.version,
				},
			})
		}
	}

	return results, nil
}

type crashInfo struct {
	processName   string
	exceptionType string
	version       string
	bugType       string // .ips "bug_type": 210 = kernel panic, 298 = JetsamEvent
}

func parseCrashReport(path string) (*crashInfo, error) {
	statInfo, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if statInfo.Size() > collectorFileReadLimit {
		return nil, fmt.Errorf("crash report too large")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	info := &crashInfo{processName: "Unknown"}

	// A modern .ips report is a one-line JSON header (carrying "bug_type")
	// followed by a separate JSON body (procName / exception). A whole-file
	// Unmarshal fails on the two values, so peel off the header line first; the
	// remainder is the body parsed below.
	if nl := bytes.IndexByte(data, '\n'); nl > 0 {
		var header struct {
			BugType string `json:"bug_type"`
		}
		if json.Unmarshal(data[:nl], &header) == nil && header.BugType != "" {
			info.bugType = truncateCollectorString(header.BugType)
			data = data[nl+1:]
		}
	}

	// Try JSON (.ips body, or older single-object format)
	var ipsData map[string]any
	if err := json.Unmarshal(data, &ipsData); err == nil {
		if name, ok := ipsData["procName"].(string); ok {
			info.processName = truncateCollectorString(name)
		}
		if exc, ok := ipsData["exception"].(map[string]any); ok {
			if t, ok := exc["type"].(string); ok {
				info.exceptionType = truncateCollectorString(t)
			}
		}
		if v, ok := ipsData["bundleInfo"].(map[string]any); ok {
			if ver, ok := v["CFBundleShortVersionString"].(string); ok {
				info.version = truncateCollectorString(ver)
			}
		}
		return info, nil
	}

	// Fallback: parse .crash text format
	lines := strings.SplitN(string(data), "\n", 20)
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Process:") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				info.processName = strings.TrimSpace(strings.Split(parts[1], "[")[0])
				info.processName = truncateCollectorString(info.processName)
			}
		}
		if strings.HasPrefix(line, "Exception Type:") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				info.exceptionType = truncateCollectorString(strings.TrimSpace(parts[1]))
			}
		}
		if strings.HasPrefix(line, "Version:") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				info.version = truncateCollectorString(strings.TrimSpace(parts[1]))
			}
		}
	}

	return info, nil
}

// collectPowerEvents parses `pmset -g log` for sleep/wake/shutdown events
func (c *EventLogCollector) collectPowerEvents(since time.Time) ([]EventLogEntry, error) {
	output, err := runCollectorLimitedOutput(collectorLongCommandTimeout, "pmset", "-g", "log")
	if err != nil {
		return nil, fmt.Errorf("pmset -g log failed: %w", err)
	}

	var results []EventLogEntry
	scanner := newCollectorScanner(output)

	for scanner.Scan() {
		line := scanner.Text()

		// pmset log lines look like:
		// 2024-01-15 10:30:00 +0000 Sleep  Entering Sleep state due to ...
		// 2024-01-15 10:35:00 +0000 Wake   ...
		if len(line) < 25 {
			continue
		}

		// Check for power event keywords
		var eventType, level string
		lower := strings.ToLower(line)
		switch {
		case strings.Contains(lower, "sleep"):
			eventType = "sleep"
			level = "info"
		case strings.Contains(lower, "wake"):
			eventType = "wake"
			level = "info"
		case strings.Contains(lower, "shutdown"):
			eventType = "warning"
			level = "warning"
		case strings.Contains(lower, "restart"):
			eventType = "restart"
			level = "warning"
		case strings.Contains(lower, "failure") || strings.Contains(lower, "assertion"):
			eventType = "power_failure"
			level = "error"
		default:
			continue
		}

		// Parse timestamp from the line (first 19 chars: "2024-01-15 10:30:00")
		tsStr := strings.TrimSpace(line[:19])
		ts, err := time.Parse("2006-01-02 15:04:05", tsStr)
		if err != nil {
			continue
		}

		if ts.Before(since) {
			continue
		}

		results = append(results, EventLogEntry{
			Timestamp: ts.UTC().Format(time.RFC3339),
			Level:     level,
			Category:  "system",
			Source:    "pmset",
			EventID:   fmt.Sprintf("power:%s:%d", eventType, ts.Unix()),
			Message:   truncateString(strings.TrimSpace(line[19:]), 500),
			Details: map[string]any{
				"eventType": eventType,
			},
		})
		if len(results) >= collectorResultLimit {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("pmset log parse failed: %w", err)
	}

	return results, nil
}

// mapUnifiedLevel maps macOS unified log message types to our level enum
func mapUnifiedLevel(messageType string) string {
	switch strings.ToLower(messageType) {
	case "fault":
		return "critical"
	case "error":
		return "error"
	case "default", "info":
		return "info"
	case "debug":
		return "info"
	default:
		return "info"
	}
}

func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
