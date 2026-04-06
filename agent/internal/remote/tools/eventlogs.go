package tools

import (
	"time"
)

// ListEventLogs returns available event logs
func ListEventLogs(payload map[string]any) CommandResult {
	startTime := time.Now()
	return listEventLogsOS(startTime)
}

// QueryEventLogs queries events from a specific log
func QueryEventLogs(payload map[string]any) CommandResult {
	startTime := time.Now()

	logName, _ := truncateStringBytes(GetPayloadString(payload, "logName", "System"), maxEventLogFieldBytes)
	level := GetPayloadString(payload, "level", "")
	source, _ := truncateStringBytes(GetPayloadString(payload, "source", ""), maxEventLogFieldBytes)
	eventID := GetPayloadInt(payload, "eventId", 0)
	page := GetPayloadInt(payload, "page", 1)
	limit := GetPayloadInt(payload, "limit", 50)

	if page < 1 {
		page = 1
	}
	if page > maxEventLogQueryPage {
		page = maxEventLogQueryPage
	}
	if limit < 1 || limit > 500 {
		limit = 50
	}

	return queryEventLogsOS(logName, level, source, eventID, page, limit, startTime)
}

// GetEventLogEntry returns a specific event log entry
func GetEventLogEntry(payload map[string]any) CommandResult {
	startTime := time.Now()

	logName, _ := truncateStringBytes(GetPayloadString(payload, "logName", "System"), maxEventLogFieldBytes)
	recordID := GetPayloadInt(payload, "recordId", 0)

	return getEventLogEntryOS(logName, int64(recordID), startTime)
}
