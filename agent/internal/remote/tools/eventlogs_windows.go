//go:build windows

package tools

import (
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

func listEventLogsOS(startTime time.Time) CommandResult {
	// Use PowerShell to get event log names
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		utf8PowerShellCommand(`Get-WinEvent -ListLog * -ErrorAction SilentlyContinue | Select-Object LogName, RecordCount, MaximumSizeInBytes | ConvertTo-Json`))
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
	truncated := false
	if len(output) > 0 {
		logs = parseEventLogList(string(output))
		logs, truncated = sanitizeEventLogs(logs)
	}

	response := EventLogListResponse{
		Logs:      logs,
		Truncated: truncated,
	}

	return NewSuccessResult(response, time.Since(startTime).Milliseconds())
}

func queryEventLogsOS(logName, source, xpathQuery string, levelNum, eventID, page, limit int, startTime time.Time) CommandResult {
	maxEvents := page * limit
	script := buildEventLogQueryScript(logName, source, xpathQuery, levelNum, eventID, maxEvents)

	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		utf8PowerShellCommand(script))

	output, err := cmd.Output()
	if err != nil {
		// The script exits non-zero only when the query actually failed
		// (invalid XPath, unknown log, access denied, parse error) — the
		// benign no-matching-events case exits zero with empty output.
		// Surface the failure explicitly instead of masking it as an empty
		// success (issue #3092).
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			if stderr := strings.TrimSpace(string(exitErr.Stderr)); stderr != "" {
				return NewErrorResult(fmt.Errorf("event log query failed: %s", stderr), time.Since(startTime).Milliseconds())
			}
		}
		return NewErrorResult(fmt.Errorf("event log query failed: %w", err), time.Since(startTime).Milliseconds())
	}

	events, truncated := sanitizeEventLogEntries(parseEventLogEntries(string(output)))

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
		Truncated:  truncated,
	}

	return NewSuccessResult(response, time.Since(startTime).Milliseconds())
}

func getEventLogEntryOS(logName string, recordID int64, startTime time.Time) CommandResult {
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		utf8PowerShellCommand(buildEventLogGetEntryScript(logName, recordID)))

	output, err := cmd.Output()
	if err != nil {
		// Distinguish a real failure (powershell missing, terminating error)
		// from a genuinely absent record so callers can debug it.
		return NewErrorResult(fmt.Errorf("failed to read event log %q: %w", logName, err), time.Since(startTime).Milliseconds())
	}

	entries, _ := sanitizeEventLogEntries(parseEventLogEntries(string(output)))
	if len(entries) == 0 {
		return NewErrorResult(fmt.Errorf("event not found"), time.Since(startTime).Milliseconds())
	}

	return NewSuccessResult(entries[0], time.Since(startTime).Milliseconds())
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
