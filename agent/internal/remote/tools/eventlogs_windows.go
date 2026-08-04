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

func queryEventLogsOS(logName, level, source, xpathQuery string, eventID, page, limit int, startTime time.Time) CommandResult {
	maxEvents := page * limit
	script := buildEventLogQueryScript(logName, level, source, xpathQuery, eventID, maxEvents)

	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		utf8PowerShellCommand(script))

	output, err := cmd.Output()
	if err != nil {
		if xpathQuery != "" {
			// The XPath script exits non-zero when the query itself failed
			// (e.g. invalid XPath). Surface that explicitly instead of
			// returning unfiltered or empty results (issue #3092).
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) {
				if stderr := strings.TrimSpace(string(exitErr.Stderr)); stderr != "" {
					return NewErrorResult(fmt.Errorf("event log XPath query failed: %s", stderr), time.Since(startTime).Milliseconds())
				}
			}
			return NewErrorResult(fmt.Errorf("event log XPath query failed: %w", err), time.Since(startTime).Milliseconds())
		}

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
		return NewErrorResult(fmt.Errorf("event not found"), time.Since(startTime).Milliseconds())
	}

	entries, _ := sanitizeEventLogEntries(parseEventLogEntries(string(output)))
	if len(entries) == 0 {
		return NewErrorResult(fmt.Errorf("event not found"), time.Since(startTime).Milliseconds())
	}

	return NewSuccessResult(entries[0], time.Since(startTime).Milliseconds())
}
