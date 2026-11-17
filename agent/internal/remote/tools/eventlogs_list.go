package tools

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/breeze-rmm/agent/internal/logging"
)

var eventLogListLog = logging.L("eventlogs")

// psEventLogInfo is one row of `Get-WinEvent -ListLog * | Select-Object
// LogName, RecordCount, MaximumSizeInBytes | ConvertTo-Json`. RecordCount is
// null when Windows cannot read a log's count (disabled analytic/debug
// channels), so it stays a pointer: unknown is not zero (#11975).
type psEventLogInfo struct {
	LogName            string `json:"LogName"`
	RecordCount        *int64 `json:"RecordCount"`
	MaximumSizeInBytes *int64 `json:"MaximumSizeInBytes"`
}

// defaultEventLogs is the list returned when the PowerShell output yields no
// logs. Counts are left unset: nothing was read.
func defaultEventLogs() []EventLog {
	return []EventLog{
		{Name: "System", DisplayName: "System"},
		{Name: "Application", DisplayName: "Application"},
		{Name: "Security", DisplayName: "Security"},
		{Name: "Setup", DisplayName: "Setup"},
	}
}

// parseEventLogList turns the PowerShell list-log output into EventLogs. It
// decodes the JSON (an array, or a bare object when one log matches) one row
// at a time, so a row it cannot decode loses only its own count. Output that
// is not that JSON falls back to scraping log names and reports no counts
// rather than guessing them.
func parseEventLogList(output string) []EventLog {
	trimmed := bytes.TrimSpace(bytes.TrimPrefix([]byte(output), []byte("\xef\xbb\xbf")))

	var rawRows []json.RawMessage
	if err := json.Unmarshal(trimmed, &rawRows); err != nil {
		if len(trimmed) > 0 && trimmed[0] == '{' {
			rawRows = []json.RawMessage{json.RawMessage(trimmed)}
		} else {
			eventLogListLog.Warn("event log list is not JSON; reporting names only, no record counts",
				"error", err.Error(), "outputBytes", len(trimmed))
			return scrapeEventLogNames(output)
		}
	}

	logs := make([]EventLog, 0, len(rawRows))
	for _, raw := range rawRows {
		log, ok := decodeEventLogRow(raw)
		if ok {
			logs = append(logs, log)
		}
	}
	if len(logs) == 0 {
		eventLogListLog.Warn("event log list had no named logs; returning the default list without counts",
			"rows", len(rawRows))
		return defaultEventLogs()
	}
	return logs
}

// decodeEventLogRow decodes one row. When the full row does not decode (a
// field of an unexpected type), the name is kept and the counts are dropped.
func decodeEventLogRow(raw json.RawMessage) (EventLog, bool) {
	var row psEventLogInfo
	if err := json.Unmarshal(raw, &row); err != nil {
		var nameOnly struct {
			LogName string `json:"LogName"`
		}
		if errName := json.Unmarshal(raw, &nameOnly); errName != nil {
			eventLogListLog.Warn("skipping undecodable event log row", "error", errName.Error())
			return EventLog{}, false
		}
		eventLogListLog.Warn("event log row has an unexpected field type; reporting it without a count",
			"logName", nameOnly.LogName, "error", err.Error())
		row = psEventLogInfo{LogName: nameOnly.LogName}
	}

	name := strings.TrimSpace(row.LogName)
	if name == "" {
		return EventLog{}, false
	}
	log := EventLog{Name: name, DisplayName: name, RecordCount: row.RecordCount}
	if row.MaximumSizeInBytes != nil {
		log.MaxSizeBytes = *row.MaximumSizeInBytes
	}
	return log, true
}

// scrapeEventLogNames is the line-based fallback for output that is not the
// expected JSON. It only recovers names.
func scrapeEventLogNames(output string) []EventLog {
	var logs []EventLog
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if !strings.Contains(line, "LogName") {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) < 2 {
			continue
		}
		name := strings.Trim(strings.TrimSpace(parts[1]), `",`)
		if name != "" {
			logs = append(logs, EventLog{Name: name, DisplayName: name})
		}
	}
	if len(logs) == 0 {
		return defaultEventLogs()
	}
	return logs
}
