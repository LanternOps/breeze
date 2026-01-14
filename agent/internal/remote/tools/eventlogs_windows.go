//go:build windows

package tools

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

func listEventLogsOS(startTime time.Time) CommandResult {
	// Use PowerShell to get event log names
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		`Get-WinEvent -ListLog * -ErrorAction SilentlyContinue | Select-Object LogName, RecordCount, MaximumSizeInBytes | ConvertTo-Json`)
	output, err := cmd.Output()
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to list event logs: %w", err), time.Since(startTime).Milliseconds())
	}

	// Default logs if PowerShell fails
	logs := []EventLog{
		{Name: "System", DisplayName: "System"},
		{Name: "Application", DisplayName: "Application"},
		{Name: "Security", DisplayName: "Security"},
		{Name: "Setup", DisplayName: "Setup"},
	}

	// Parse PowerShell output if available
	if len(output) > 0 {
		logs = parseEventLogList(string(output))
	}

	response := EventLogListResponse{
		Logs: logs,
	}

	return NewSuccessResult(response, time.Since(startTime).Milliseconds())
}

func queryEventLogsOS(logName, level, source string, eventID, page, limit int, startTime time.Time) CommandResult {
	// Build PowerShell filter
	filter := fmt.Sprintf("LogName='%s'", logName)
	if level != "" {
		levelNum := levelToNumber(level)
		if levelNum > 0 {
			filter += fmt.Sprintf(" and Level=%d", levelNum)
		}
	}
	if source != "" {
		filter += fmt.Sprintf(" and ProviderName='%s'", source)
	}
	if eventID > 0 {
		filter += fmt.Sprintf(" and Id=%d", eventID)
	}

	// Query events using PowerShell
	maxEvents := page * limit
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		fmt.Sprintf(`Get-WinEvent -FilterHashtable @{%s} -MaxEvents %d -ErrorAction SilentlyContinue | `+
			`Select-Object RecordId, LogName, LevelDisplayName, TimeCreated, ProviderName, Id, Message | `+
			`ConvertTo-Json -Depth 2`, filter, maxEvents))

	output, err := cmd.Output()
	if err != nil {
		// Return empty result if no events found
		response := EventLogQueryResponse{
			Events:     []EventLogEntry{},
			Total:      0,
			Page:       page,
			Limit:      limit,
			TotalPages: 0,
		}
		return NewSuccessResult(response, time.Since(startTime).Milliseconds())
	}

	events := parseEventLogEntries(string(output))

	// Paginate
	total := len(events)
	totalPages := (total + limit - 1) / limit
	start := (page - 1) * limit
	end := start + limit

	if start > total {
		start = total
	}
	if end > total {
		end = total
	}

	response := EventLogQueryResponse{
		Events:     events[start:end],
		Total:      total,
		Page:       page,
		Limit:      limit,
		TotalPages: totalPages,
	}

	return NewSuccessResult(response, time.Since(startTime).Milliseconds())
}

func getEventLogEntryOS(logName string, recordID int64, startTime time.Time) CommandResult {
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		fmt.Sprintf(`Get-WinEvent -FilterHashtable @{LogName='%s'} -ErrorAction SilentlyContinue | `+
			`Where-Object { $_.RecordId -eq %d } | `+
			`Select-Object RecordId, LogName, LevelDisplayName, TimeCreated, ProviderName, Id, Message, UserId, MachineName | `+
			`ConvertTo-Json -Depth 2`, logName, recordID))

	output, err := cmd.Output()
	if err != nil {
		return NewErrorResult(fmt.Errorf("event not found"), time.Since(startTime).Milliseconds())
	}

	entries := parseEventLogEntries(string(output))
	if len(entries) == 0 {
		return NewErrorResult(fmt.Errorf("event not found"), time.Since(startTime).Milliseconds())
	}

	return NewSuccessResult(entries[0], time.Since(startTime).Milliseconds())
}

func levelToNumber(level string) int {
	switch strings.ToLower(level) {
	case "critical":
		return 1
	case "error":
		return 2
	case "warning":
		return 3
	case "information", "info":
		return 4
	case "verbose":
		return 5
	default:
		return 0
	}
}

func parseEventLogList(output string) []EventLog {
	// Basic parsing - in production, use proper JSON parsing
	var logs []EventLog

	// Parse lines for log names
	lines := strings.Split(output, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.Contains(line, "LogName") {
			// Extract log name
			parts := strings.Split(line, ":")
			if len(parts) >= 2 {
				name := strings.TrimSpace(parts[1])
				name = strings.Trim(name, `",`)
				if name != "" {
					logs = append(logs, EventLog{
						Name:        name,
						DisplayName: name,
					})
				}
			}
		}
	}

	// Return default logs if parsing failed
	if len(logs) == 0 {
		return []EventLog{
			{Name: "System", DisplayName: "System"},
			{Name: "Application", DisplayName: "Application"},
			{Name: "Security", DisplayName: "Security"},
		}
	}

	return logs
}

func parseEventLogEntries(output string) []EventLogEntry {
	var entries []EventLogEntry

	// Basic line-by-line parsing
	lines := strings.Split(output, "\n")
	var current *EventLogEntry

	for _, line := range lines {
		line = strings.TrimSpace(line)

		if strings.Contains(line, "RecordId") {
			if current != nil {
				entries = append(entries, *current)
			}
			current = &EventLogEntry{}
			val := extractValue(line)
			if id, err := strconv.ParseInt(val, 10, 64); err == nil {
				current.RecordID = id
			}
		} else if current != nil {
			if strings.Contains(line, "LogName") {
				current.LogName = extractValue(line)
			} else if strings.Contains(line, "LevelDisplayName") {
				current.Level = extractValue(line)
			} else if strings.Contains(line, "TimeCreated") {
				// Parse time
				val := extractValue(line)
				if t, err := time.Parse(time.RFC3339, val); err == nil {
					current.TimeCreated = t
				}
			} else if strings.Contains(line, "ProviderName") {
				current.Source = extractValue(line)
			} else if strings.Contains(line, `"Id"`) {
				val := extractValue(line)
				if id, err := strconv.Atoi(val); err == nil {
					current.EventID = id
				}
			} else if strings.Contains(line, "Message") {
				current.Message = extractValue(line)
			}
		}
	}

	if current != nil {
		entries = append(entries, *current)
	}

	return entries
}

func extractValue(line string) string {
	parts := strings.SplitN(line, ":", 2)
	if len(parts) < 2 {
		return ""
	}
	val := strings.TrimSpace(parts[1])
	val = strings.Trim(val, `",`)
	return val
}
