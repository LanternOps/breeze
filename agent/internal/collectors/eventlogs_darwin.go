//go:build darwin

package collectors

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
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

	var wg sync.WaitGroup
	var mu sync.Mutex
	var allEvents []EventLogEntry

	type collectorFunc func(since time.Time) ([]EventLogEntry, error)

	collectors := []collectorFunc{
		c.collectSecurityEvents,
		c.collectHardwareErrors,
		c.collectCrashReports,
		c.collectPowerEvents,
	}

	wg.Add(len(collectors))
	for _, fn := range collectors {
		go func(f collectorFunc) {
			defer wg.Done()
			events, err := f(lastCollect)
			if err != nil {
				fmt.Printf("Event log sub-collector error: %v\n", err)
				return
			}
			mu.Lock()
			allEvents = append(allEvents, events...)
			mu.Unlock()
		}(fn)
	}
	wg.Wait()

	c.mu.Lock()
	c.lastCollectTime = time.Now()
	c.mu.Unlock()

	// Cap to maxEvents
	if len(allEvents) > c.maxEvents {
		allEvents = allEvents[:c.maxEvents]
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

// collectSecurityEvents gathers auth failures, TCC changes from unified log
func (c *EventLogCollector) collectSecurityEvents(since time.Time) ([]EventLogEntry, error) {
	predicate := `subsystem == "com.apple.opendirectoryd" OR eventMessage CONTAINS[c] "authentication" OR subsystem == "com.apple.TCC"`

	return c.queryUnifiedLog(predicate, "security", since)
}

// collectHardwareErrors gathers disk, thermal, kernel errors from unified log
func (c *EventLogCollector) collectHardwareErrors(since time.Time) ([]EventLogEntry, error) {
	predicate := `(subsystem CONTAINS "com.apple.iokit" AND messageType >= error) OR eventMessage CONTAINS[c] "thermal" OR eventMessage CONTAINS[c] "kernel panic"`

	return c.queryUnifiedLog(predicate, "hardware", since)
}

// queryUnifiedLog runs `log show` with a predicate and returns parsed entries
func (c *EventLogCollector) queryUnifiedLog(predicate, category string, since time.Time) ([]EventLogEntry, error) {
	elapsed := time.Since(since)
	lastMinutes := int(elapsed.Minutes())
	if lastMinutes < 1 {
		lastMinutes = 1
	}
	if lastMinutes > 60 {
		lastMinutes = 60
	}

	cmd := exec.Command("log", "show",
		"--predicate", predicate,
		"--style", "json",
		"--last", fmt.Sprintf("%dm", lastMinutes),
	)

	output, err := cmd.Output()
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
			Category:  category,
			Source:    source,
			EventID:   fmt.Sprintf("%s:%d", source, e.ProcessID),
			Message:   truncateString(e.EventMessage, 500),
			Details: map[string]any{
				"subsystem":  e.Subsystem,
				"processId":  e.ProcessID,
				"logCategory": e.Category,
			},
		})
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

			results = append(results, EventLogEntry{
				Timestamp: info.ModTime().UTC().Format(time.RFC3339),
				Level:     "error",
				Category:  "application",
				Source:    crashData.processName,
				EventID:   fmt.Sprintf("crash:%s", name),
				Message:   fmt.Sprintf("Application crash: %s (%s)", crashData.processName, crashData.exceptionType),
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
}

func parseCrashReport(path string) (*crashInfo, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	info := &crashInfo{processName: "Unknown"}

	// Try JSON (.ips format)
	var ipsData map[string]any
	if err := json.Unmarshal(data, &ipsData); err == nil {
		if name, ok := ipsData["procName"].(string); ok {
			info.processName = name
		}
		if exc, ok := ipsData["exception"].(map[string]any); ok {
			if t, ok := exc["type"].(string); ok {
				info.exceptionType = t
			}
		}
		if v, ok := ipsData["bundleInfo"].(map[string]any); ok {
			if ver, ok := v["CFBundleShortVersionString"].(string); ok {
				info.version = ver
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
			}
		}
		if strings.HasPrefix(line, "Exception Type:") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				info.exceptionType = strings.TrimSpace(parts[1])
			}
		}
		if strings.HasPrefix(line, "Version:") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				info.version = strings.TrimSpace(parts[1])
			}
		}
	}

	return info, nil
}

// collectPowerEvents parses `pmset -g log` for sleep/wake/shutdown events
func (c *EventLogCollector) collectPowerEvents(since time.Time) ([]EventLogEntry, error) {
	cmd := exec.Command("pmset", "-g", "log")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("pmset -g log failed: %w", err)
	}

	var results []EventLogEntry
	scanner := bufio.NewScanner(strings.NewReader(string(output)))

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
