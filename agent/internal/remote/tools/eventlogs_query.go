package tools

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// eventLogTimeCreatedProjection projects TimeCreated to a stable ISO 8601 UTC
// string. Without it, Windows PowerShell 5.1's ConvertTo-Json serializes
// DateTime values as "\/Date(1754224496000)\/", which the Go parser could not
// read — events came back with blank timestamps (issue #3092).
const eventLogTimeCreatedProjection = `@{Name='TimeCreated';Expression={if ($_.TimeCreated) { $_.TimeCreated.ToUniversalTime().ToString('o') } else { $null }}}`

// eventLogSelectClause returns the Select-Object property list shared by the
// event log query and get-entry PowerShell pipelines. extra appends additional
// properties (e.g. "UserId, MachineName" for get-entry).
func eventLogSelectClause(extra string) string {
	clause := "RecordId, LogName, LevelDisplayName, " + eventLogTimeCreatedProjection + ", ProviderName, Id, Message"
	if extra != "" {
		clause += ", " + extra
	}
	return clause
}

// buildEventLogQueryScript builds the PowerShell pipeline for event_logs_query.
//
// When xpathQuery is set, the query runs through Get-WinEvent -FilterXPath with
// -ErrorAction Stop inside try/catch: an invalid XPath exits non-zero with the
// error on stderr (so the caller gets an explicit failure instead of silently
// unfiltered results — issue #3092), while the not-an-error "no matching
// events" case (matched by its locale-independent FullyQualifiedErrorId)
// produces empty output and a zero exit.
//
// When xpathQuery is empty, the legacy -FilterHashtable path is used with its
// existing -ErrorAction SilentlyContinue semantics.
func buildEventLogQueryScript(logName, level, source, xpathQuery string, eventID, maxEvents int) string {
	selectClause := eventLogSelectClause("")

	if xpathQuery != "" {
		return fmt.Sprintf(
			`try { Get-WinEvent -LogName '%s' -FilterXPath '%s' -MaxEvents %d -ErrorAction Stop | `+
				`Select-Object %s | ConvertTo-Json -Depth 2 } catch { `+
				`if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { '' } else { `+
				`[Console]::Error.WriteLine($_.Exception.Message); exit 1 } }`,
			escapePowerShellSingleQuoted(logName), escapePowerShellSingleQuoted(xpathQuery), maxEvents, selectClause)
	}

	filter := fmt.Sprintf("LogName='%s'", escapePowerShellSingleQuoted(logName))
	if level != "" {
		if levelNum := levelToNumber(level); levelNum > 0 {
			filter += fmt.Sprintf(" and Level=%d", levelNum)
		}
	}
	if source != "" {
		filter += fmt.Sprintf(" and ProviderName='%s'", escapePowerShellSingleQuoted(source))
	}
	if eventID > 0 {
		filter += fmt.Sprintf(" and Id=%d", eventID)
	}

	return fmt.Sprintf(`Get-WinEvent -FilterHashtable @{%s} -MaxEvents %d -ErrorAction SilentlyContinue | `+
		`Select-Object %s | ConvertTo-Json -Depth 2`, filter, maxEvents, selectClause)
}

// buildEventLogGetEntryScript builds the PowerShell pipeline for event_log_get.
func buildEventLogGetEntryScript(logName string, recordID int64) string {
	return fmt.Sprintf(`Get-WinEvent -FilterHashtable @{LogName='%s'} -ErrorAction SilentlyContinue | `+
		`Where-Object { $_.RecordId -eq %d } | Select-Object -First 1 | `+
		`Select-Object %s | ConvertTo-Json -Depth 2`,
		escapePowerShellSingleQuoted(logName), recordID, eventLogSelectClause("UserId, MachineName"))
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

// dotNetJSONDateRe matches the .NET JSON date format emitted by Windows
// PowerShell 5.1's ConvertTo-Json for DateTime values: /Date(1754224496000)/
// (milliseconds since the Unix epoch, optionally with a display offset).
var dotNetJSONDateRe = regexp.MustCompile(`^/Date\((-?\d+)(?:[+-]\d{4})?\)/$`)

// parseEventLogTime parses a TimeCreated value from PowerShell JSON output.
// Accepts RFC 3339 (with or without fractional seconds, as produced by the
// ToString('o') projection) and the legacy PS 5.1 \/Date(ms)\/ form.
func parseEventLogTime(val string) (time.Time, bool) {
	val = strings.TrimSpace(val)
	if val == "" || val == "null" {
		return time.Time{}, false
	}
	// PS 5.1 ConvertTo-Json escapes forward slashes: \/Date(123)\/
	val = strings.ReplaceAll(val, `\/`, `/`)

	if m := dotNetJSONDateRe.FindStringSubmatch(val); m != nil {
		ms, err := strconv.ParseInt(m[1], 10, 64)
		if err != nil {
			return time.Time{}, false
		}
		return time.UnixMilli(ms).UTC(), true
	}

	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, val); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
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
				if t, ok := parseEventLogTime(extractValue(line)); ok {
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
