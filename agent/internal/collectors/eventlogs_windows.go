//go:build windows

package collectors

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Collect gathers event logs from Windows Event Log sources in parallel
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
		c.collectSystemErrors,
		c.collectApplicationCrashes,
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

// winEvent represents a single Windows Event Log entry from PowerShell JSON output
type winEvent struct {
	RecordId         int64  `json:"RecordId"`
	LogName          string `json:"LogName"`
	Level            int    `json:"Level"`
	LevelDisplayName string `json:"LevelDisplayName"`
	TimeCreated      string `json:"TimeCreated"`
	ProviderName     string `json:"ProviderName"`
	Id               int    `json:"Id"`
	Message          string `json:"Message"`
}

// collectSecurityEvents gathers auth failures, lockouts, privilege escalation from Security log
func (c *EventLogCollector) collectSecurityEvents(since time.Time) ([]EventLogEntry, error) {
	events, err := c.queryWinEvents("Security", 3, since)
	if err != nil {
		return nil, err
	}

	var results []EventLogEntry
	for _, e := range events {
		results = append(results, EventLogEntry{
			Timestamp: e.TimeCreated,
			Level:     mapWinLevel(e.Level),
			Category:  "security",
			Source:    e.ProviderName,
			EventID:   fmt.Sprintf("%d:%d", e.Id, e.RecordId),
			Message:   truncateString(e.Message, 500),
			Details: map[string]any{
				"recordId": e.RecordId,
				"logName":  e.LogName,
				"eventId":  e.Id,
			},
		})
	}

	return results, nil
}

// collectSystemErrors gathers disk errors, driver failures, WHEA errors from System log
func (c *EventLogCollector) collectSystemErrors(since time.Time) ([]EventLogEntry, error) {
	events, err := c.queryWinEvents("System", 2, since)
	if err != nil {
		return nil, err
	}

	var results []EventLogEntry
	for _, e := range events {
		results = append(results, EventLogEntry{
			Timestamp: e.TimeCreated,
			Level:     mapWinLevel(e.Level),
			Category:  "hardware",
			Source:    e.ProviderName,
			EventID:   fmt.Sprintf("%d:%d", e.Id, e.RecordId),
			Message:   truncateString(e.Message, 500),
			Details: map[string]any{
				"recordId": e.RecordId,
				"logName":  e.LogName,
				"eventId":  e.Id,
			},
		})
	}

	return results, nil
}

// collectApplicationCrashes gathers app crashes, .NET exceptions, WER from Application log
func (c *EventLogCollector) collectApplicationCrashes(since time.Time) ([]EventLogEntry, error) {
	events, err := c.queryWinEvents("Application", 2, since)
	if err != nil {
		return nil, err
	}

	var results []EventLogEntry
	for _, e := range events {
		results = append(results, EventLogEntry{
			Timestamp: e.TimeCreated,
			Level:     mapWinLevel(e.Level),
			Category:  "application",
			Source:    e.ProviderName,
			EventID:   fmt.Sprintf("%d:%d", e.Id, e.RecordId),
			Message:   truncateString(e.Message, 500),
			Details: map[string]any{
				"recordId": e.RecordId,
				"logName":  e.LogName,
				"eventId":  e.Id,
			},
		})
	}

	return results, nil
}

// collectPowerEvents gathers shutdown/restart/boot events from System log by specific Event IDs
func (c *EventLogCollector) collectPowerEvents(since time.Time) ([]EventLogEntry, error) {
	sinceStr := since.UTC().Format(time.RFC3339)

	// Query specific power-related Event IDs from the System log
	// 41=unexpected shutdown, 1074=planned shutdown, 6005=boot, 6006=clean shutdown, 6008=unexpected shutdown, 6009=OS info at boot
	psCmd := fmt.Sprintf(
		`Get-WinEvent -FilterHashtable @{LogName='System'; Id=41,1074,6005,6006,6008,6009; StartTime='%s'} -MaxEvents 50 -ErrorAction SilentlyContinue | `+
			`Select-Object RecordId, LogName, Level, LevelDisplayName, @{N='TimeCreated';E={$_.TimeCreated.ToString('o')}}, ProviderName, Id, Message | `+
			`ConvertTo-Json -Depth 2 -Compress`,
		sinceStr,
	)

	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", psCmd)
	output, err := cmd.Output()
	if err != nil {
		// No events found is not an error
		return nil, nil
	}

	if len(output) == 0 {
		return nil, nil
	}

	events := parseWinEventJSON(output)

	var results []EventLogEntry
	for _, e := range events {
		level := mapPowerEventLevel(e.Id)

		results = append(results, EventLogEntry{
			Timestamp: e.TimeCreated,
			Level:     level,
			Category:  "system",
			Source:    e.ProviderName,
			EventID:   fmt.Sprintf("%d:%d", e.Id, e.RecordId),
			Message:   truncateString(e.Message, 500),
			Details: map[string]any{
				"recordId":  e.RecordId,
				"logName":   e.LogName,
				"eventId":   e.Id,
				"eventType": mapPowerEventType(e.Id),
			},
		})
	}

	return results, nil
}

// queryWinEvents runs a PowerShell Get-WinEvent query and returns parsed events.
// maxLevel filters events: 2 = error+critical, 3 = warning+error+critical.
func (c *EventLogCollector) queryWinEvents(logName string, maxLevel int, since time.Time) ([]winEvent, error) {
	sinceStr := since.UTC().Format(time.RFC3339)

	// Build Level filter: Level 1=Critical, 2=Error, 3=Warning
	levels := make([]string, 0, maxLevel)
	for i := 1; i <= maxLevel; i++ {
		levels = append(levels, strconv.Itoa(i))
	}
	levelFilter := strings.Join(levels, ",")

	psCmd := fmt.Sprintf(
		`Get-WinEvent -FilterHashtable @{LogName='%s'; Level=%s; StartTime='%s'} -MaxEvents 50 -ErrorAction SilentlyContinue | `+
			`Select-Object RecordId, LogName, Level, LevelDisplayName, @{N='TimeCreated';E={$_.TimeCreated.ToString('o')}}, ProviderName, Id, Message | `+
			`ConvertTo-Json -Depth 2 -Compress`,
		logName, levelFilter, sinceStr,
	)

	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", psCmd)
	output, err := cmd.Output()
	if err != nil {
		// No events found is not an error
		return nil, nil
	}

	if len(output) == 0 {
		return nil, nil
	}

	return parseWinEventJSON(output), nil
}

// parseWinEventJSON parses PowerShell ConvertTo-Json output into winEvent slices.
// Handles both single-object and array JSON (PowerShell returns a bare object for 1 result).
func parseWinEventJSON(data []byte) []winEvent {
	trimmed := strings.TrimSpace(string(data))
	if len(trimmed) == 0 {
		return nil
	}

	// Try array first
	var events []winEvent
	if err := json.Unmarshal([]byte(trimmed), &events); err == nil {
		return events
	}

	// Single object (PowerShell omits array wrapper for 1 result)
	var single winEvent
	if err := json.Unmarshal([]byte(trimmed), &single); err == nil {
		return []winEvent{single}
	}

	return nil
}

// mapWinLevel maps Windows Event Log numeric level to our level enum
func mapWinLevel(level int) string {
	switch level {
	case 1:
		return "critical"
	case 2:
		return "error"
	case 3:
		return "warning"
	case 4, 5:
		return "info"
	default:
		return "info"
	}
}

// mapPowerEventLevel returns the severity level for known power Event IDs
func mapPowerEventLevel(eventID int) string {
	switch eventID {
	case 41: // Kernel-Power: unexpected shutdown (bugcheck)
		return "critical"
	case 6008: // Unexpected shutdown (previous boot)
		return "warning"
	case 1074: // User32: planned restart/shutdown
		return "info"
	case 6005: // EventLog service started (boot)
		return "info"
	case 6006: // EventLog service stopped (clean shutdown)
		return "info"
	case 6009: // OS version info at boot
		return "info"
	default:
		return "info"
	}
}

// mapPowerEventType returns a human-readable type string for known power Event IDs
func mapPowerEventType(eventID int) string {
	switch eventID {
	case 41:
		return "unexpected_shutdown"
	case 1074:
		return "planned_shutdown"
	case 6005:
		return "boot"
	case 6006:
		return "clean_shutdown"
	case 6008:
		return "unexpected_shutdown"
	case 6009:
		return "boot_info"
	default:
		return "power"
	}
}

func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
