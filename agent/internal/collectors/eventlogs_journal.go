package collectors

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// journald (journalctl --output=json) parsing and entry conversion for the
// Linux event-log collector. Platform-neutral (no build tag) so the
// conversion and event-id rules are unit-tested on every CI OS;
// eventlogs_linux.go is the only runtime caller.

// journalEntry matches the JSON output of journalctl --output=json
type journalEntry struct {
	RealtimeTimestamp string `json:"__REALTIME_TIMESTAMP"` // microseconds since epoch
	SyslogIdentifier  string `json:"SYSLOG_IDENTIFIER"`
	Unit              string `json:"_SYSTEMD_UNIT"`
	Message           string `json:"MESSAGE"`
	Priority          string `json:"PRIORITY"` // 0-7 syslog levels
	PID               string `json:"_PID"`
	BootID            string `json:"_BOOT_ID"`
}

// journalSecurityEvents converts sshd/sudo/su/pam journal entries to events.
func journalSecurityEvents(entries []journalEntry) []EventLogEntry {
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
			Source:    truncateCollectorString(e.SyslogIdentifier),
			EventID:   truncateCollectorString(fmt.Sprintf("%s:%s", e.SyslogIdentifier, e.PID)),
			Message:   truncateString(e.Message, 500),
			Details: map[string]any{
				"unit": truncateCollectorString(e.Unit),
				"pid":  truncateCollectorString(e.PID),
			},
		})
		if len(results) >= collectorResultLimit {
			break
		}
	}

	return results
}

// journalKernelEvents converts kernel journal entries (priority 0..4) to events.
func journalKernelEvents(entries []journalEntry) []EventLogEntry {
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
			EventID:   truncateCollectorString(fmt.Sprintf("kernel:%s", e.PID)),
			Message:   truncateString(e.Message, 500),
			Details: map[string]any{
				"pid": truncateCollectorString(e.PID),
			},
		})
		if len(results) >= collectorResultLimit {
			break
		}
	}

	return results
}

// journalServiceFailureEvents converts systemd failure and coredump entries to events.
func journalServiceFailureEvents(entries []journalEntry) []EventLogEntry {
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
			EventID:   truncateCollectorString(fmt.Sprintf("%s:%s", source, e.PID)),
			Message:   truncateString(e.Message, 500),
			Details: map[string]any{
				"unit": truncateCollectorString(e.Unit),
				"pid":  truncateCollectorString(e.PID),
			},
		})
		if len(results) >= collectorResultLimit {
			break
		}
	}

	return results
}

// journalSystemEvents keeps the boot/shutdown/lifecycle subset of systemd
// entries (priority 4..6) and converts it to events.
func journalSystemEvents(entries []journalEntry) []EventLogEntry {
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
			EventID:   truncateCollectorString(fmt.Sprintf("systemd:%s:%s", e.BootID, e.PID)),
			Message:   truncateString(e.Message, 500),
			Details: map[string]any{
				"unit":   truncateCollectorString(e.Unit),
				"bootId": truncateCollectorString(e.BootID),
			},
		})
		if len(results) >= collectorResultLimit {
			break
		}
	}

	return results
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

func parseJournalJSONLines(output []byte) []journalEntry {
	var entries []journalEntry
	scanner := newCollectorScanner(output)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry journalEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		entry.SyslogIdentifier = truncateCollectorString(entry.SyslogIdentifier)
		entry.Unit = truncateCollectorString(entry.Unit)
		entry.Message = truncateString(entry.Message, 500)
		entry.Priority = truncateCollectorString(entry.Priority)
		entry.PID = truncateCollectorString(entry.PID)
		entry.BootID = truncateCollectorString(entry.BootID)
		entries = append(entries, entry)
		if len(entries) >= collectorResultLimit {
			break
		}
	}
	return entries
}
