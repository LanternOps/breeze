package tools

import (
	"bytes"
	"encoding/json"
	"strings"
)

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
	}
}

// parseEventLogList turns the PowerShell list-log output into EventLogs. It
// decodes the JSON (an array, or a bare object when one log matches); if the
// output is not that JSON it falls back to scraping log names and reports no
// counts rather than guessing them.
func parseEventLogList(output string) []EventLog {
	trimmed := bytes.TrimSpace(bytes.TrimPrefix([]byte(output), []byte("\xef\xbb\xbf")))

	var rows []psEventLogInfo
	if err := json.Unmarshal(trimmed, &rows); err != nil {
		var row psEventLogInfo
		if errObj := json.Unmarshal(trimmed, &row); errObj != nil {
			return scrapeEventLogNames(output)
		}
		rows = []psEventLogInfo{row}
	}

	logs := make([]EventLog, 0, len(rows))
	for _, r := range rows {
		name := strings.TrimSpace(r.LogName)
		if name == "" {
			continue
		}
		log := EventLog{Name: name, DisplayName: name, RecordCount: r.RecordCount}
		if r.MaximumSizeInBytes != nil {
			log.MaxSizeBytes = *r.MaximumSizeInBytes
		}
		logs = append(logs, log)
	}
	if len(logs) == 0 {
		return defaultEventLogs()
	}
	return logs
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
