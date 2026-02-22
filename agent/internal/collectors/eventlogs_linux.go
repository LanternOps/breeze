//go:build linux

package collectors

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Collect gathers event logs from Linux sources (journalctl) in parallel
func (c *EventLogCollector) Collect() ([]EventLogEntry, error) {
	c.mu.Lock()
	lastCollect := c.lastCollectTime
	c.mu.Unlock()

	categories, minLevel, maxEvents := c.readConfig()

	type catCollector struct {
		category string
		fn       func(since time.Time) ([]EventLogEntry, error)
	}

	all := []catCollector{
		{"security", c.collectSecurityEvents},
		{"hardware", c.collectKernelErrors},
		{"application", c.collectServiceFailures},
		{"system", c.collectSystemEvents},
	}

	// Filter to only enabled categories
	var active []catCollector
	for _, cc := range all {
		if categoryEnabled(categories, cc.category) {
			active = append(active, cc)
		}
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	var allEvents []EventLogEntry

	wg.Add(len(active))
	for _, cc := range active {
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
		}(cc.fn)
	}
	wg.Wait()

	c.mu.Lock()
	c.lastCollectTime = time.Now()
	c.mu.Unlock()

	// Filter by minimum level
	allEvents = filterByLevel(allEvents, minLevel)

	// Cap to maxEvents
	if len(allEvents) > maxEvents {
		allEvents = allEvents[:maxEvents]
	}

	return allEvents, nil
}

// journalEntry matches the JSON output of journalctl --output=json
type journalEntry struct {
	RealtimeTimestamp string `json:"__REALTIME_TIMESTAMP"` // microseconds since epoch
	SyslogIdentifier string `json:"SYSLOG_IDENTIFIER"`
	Unit             string `json:"_SYSTEMD_UNIT"`
	Message          string `json:"MESSAGE"`
	Priority         string `json:"PRIORITY"` // 0-7 syslog levels
	PID              string `json:"_PID"`
	BootID           string `json:"_BOOT_ID"`
}

// collectSecurityEvents gathers auth failures, sudo events, sshd events
func (c *EventLogCollector) collectSecurityEvents(since time.Time) ([]EventLogEntry, error) {
	entries, err := c.queryJournal(since,
		"SYSLOG_IDENTIFIER=sshd",
		"+", // OR
		"SYSLOG_IDENTIFIER=sudo",
		"+",
		"SYSLOG_IDENTIFIER=su",
		"+",
		"_COMM=pam",
	)
	if err != nil {
		return nil, err
	}

	var results []EventLogEntry
	for _, e := range entries {
		level := mapSyslogPriority(e.Priority)
		// Elevate auth failures
		msg := strings.ToLower(e.Message)
		if strings.Contains(msg, "failed") || strings.Contains(msg, "failure") || strings.Contains(msg, "invalid") {
			if level == "info" {
				level = "warning"
			}
		}

		results = append(results, EventLogEntry{
			Timestamp: parseJournalTimestamp(e.RealtimeTimestamp),
			Level:     level,
			Category:  "security",
			Source:    e.SyslogIdentifier,
			EventID:   fmt.Sprintf("%s:%s", e.SyslogIdentifier, e.PID),
			Message:   truncateString(e.Message, 500),
			Details: map[string]any{
				"unit": e.Unit,
				"pid":  e.PID,
			},
		})
	}

	return results, nil
}

// collectKernelErrors gathers disk I/O errors, OOM kills, hardware errors from kernel
func (c *EventLogCollector) collectKernelErrors(since time.Time) ([]EventLogEntry, error) {
	entries, err := c.queryJournal(since,
		"SYSLOG_IDENTIFIER=kernel",
		"PRIORITY=0..4", // emerg through warning
	)
	if err != nil {
		return nil, err
	}

	var results []EventLogEntry
	for _, e := range entries {
		level := mapSyslogPriority(e.Priority)
		// Classify by message content
		msg := strings.ToLower(e.Message)
		switch {
		case strings.Contains(msg, "oom") || strings.Contains(msg, "out of memory"):
			level = "critical"
		case strings.Contains(msg, "i/o error") || strings.Contains(msg, "blk_update_request"):
			level = "error"
		}

		results = append(results, EventLogEntry{
			Timestamp: parseJournalTimestamp(e.RealtimeTimestamp),
			Level:     level,
			Category:  "hardware",
			Source:    "kernel",
			EventID:   fmt.Sprintf("kernel:%s", e.PID),
			Message:   truncateString(e.Message, 500),
			Details: map[string]any{
				"pid": e.PID,
			},
		})
	}

	return results, nil
}

// collectServiceFailures gathers systemd unit failures and coredumps
func (c *EventLogCollector) collectServiceFailures(since time.Time) ([]EventLogEntry, error) {
	entries, err := c.queryJournal(since,
		"SYSLOG_IDENTIFIER=systemd",
		"PRIORITY=0..3", // emerg through error
	)
	if err != nil {
		return nil, err
	}

	// Also check for coredumps
	coredumps, err := c.queryJournal(since,
		"SYSLOG_IDENTIFIER=systemd-coredump",
	)
	if err == nil {
		entries = append(entries, coredumps...)
	}

	var results []EventLogEntry
	for _, e := range entries {
		level := mapSyslogPriority(e.Priority)
		source := e.SyslogIdentifier
		if source == "" {
			source = "systemd"
		}

		results = append(results, EventLogEntry{
			Timestamp: parseJournalTimestamp(e.RealtimeTimestamp),
			Level:     level,
			Category:  "application",
			Source:    source,
			EventID:   fmt.Sprintf("%s:%s", source, e.PID),
			Message:   truncateString(e.Message, 500),
			Details: map[string]any{
				"unit": e.Unit,
				"pid":  e.PID,
			},
		})
	}

	return results, nil
}

// collectSystemEvents gathers boot, shutdown, and systemd lifecycle events
func (c *EventLogCollector) collectSystemEvents(since time.Time) ([]EventLogEntry, error) {
	entries, err := c.queryJournal(since,
		"SYSLOG_IDENTIFIER=systemd",
		"PRIORITY=4..6", // warning through info
	)
	if err != nil {
		return nil, err
	}

	var results []EventLogEntry
	for _, e := range entries {
		msg := strings.ToLower(e.Message)
		// Only include boot/shutdown/lifecycle events
		isLifecycle := strings.Contains(msg, "started") ||
			strings.Contains(msg, "stopped") ||
			strings.Contains(msg, "reached target") ||
			strings.Contains(msg, "startup finished") ||
			strings.Contains(msg, "shutting down") ||
			strings.Contains(msg, "reboot")

		if !isLifecycle {
			continue
		}

		level := mapSyslogPriority(e.Priority)
		if strings.Contains(msg, "shutting down") || strings.Contains(msg, "reboot") {
			level = "warning"
		}

		results = append(results, EventLogEntry{
			Timestamp: parseJournalTimestamp(e.RealtimeTimestamp),
			Level:     level,
			Category:  "system",
			Source:    "systemd",
			EventID:   fmt.Sprintf("systemd:%s:%s", e.BootID, e.PID),
			Message:   truncateString(e.Message, 500),
			Details: map[string]any{
				"unit":   e.Unit,
				"bootId": e.BootID,
			},
		})
	}

	return results, nil
}

// queryJournal runs journalctl with JSON output and returns parsed entries
func (c *EventLogCollector) queryJournal(since time.Time, matches ...string) ([]journalEntry, error) {
	sinceStr := since.UTC().Format("2006-01-02 15:04:05")

	args := []string{
		"--output=json",
		"--no-pager",
		"--since", sinceStr,
		"-n", "50",
	}
	args = append(args, matches...)

	cmd := exec.Command("journalctl", args...)
	output, err := cmd.Output()
	if err != nil {
		// journalctl returns exit code 1 when no entries match
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return nil, nil
		}
		return nil, fmt.Errorf("journalctl failed: %w", err)
	}

	if len(output) == 0 {
		return nil, nil
	}

	// journalctl --output=json outputs one JSON object per line (JSONL)
	var entries []journalEntry
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var entry journalEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		entries = append(entries, entry)
	}

	return entries, nil
}

// parseJournalTimestamp converts journalctl __REALTIME_TIMESTAMP (microseconds) to RFC3339
func parseJournalTimestamp(usec string) string {
	if usec == "" {
		return time.Now().UTC().Format(time.RFC3339)
	}
	var us int64
	for _, c := range usec {
		if c >= '0' && c <= '9' {
			us = us*10 + int64(c-'0')
		}
	}
	t := time.Unix(us/1_000_000, (us%1_000_000)*1000)
	return t.UTC().Format(time.RFC3339)
}

// mapSyslogPriority maps syslog numeric priority to our level enum
// 0=emerg, 1=alert, 2=crit, 3=err, 4=warning, 5=notice, 6=info, 7=debug
func mapSyslogPriority(priority string) string {
	switch priority {
	case "0", "1":
		return "critical"
	case "2", "3":
		return "error"
	case "4":
		return "warning"
	case "5", "6":
		return "info"
	case "7":
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
