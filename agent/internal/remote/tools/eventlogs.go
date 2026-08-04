package tools

import (
	"fmt"
	"strings"
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
	xpathQuery := strings.TrimSpace(GetPayloadString(payload, "query", ""))
	eventID := GetPayloadInt(payload, "eventId", 0)
	page := GetPayloadInt(payload, "page", 1)
	limit := GetPayloadInt(payload, "limit", 50)

	// The XPath query must be applied verbatim or rejected — never truncated
	// (a truncated XPath is a different query) and never silently dropped
	// (issue #3092: callers received confidently unfiltered results).
	if len(xpathQuery) > maxEventLogXPathBytes {
		return NewErrorResult(
			fmt.Errorf("query exceeds the maximum XPath length of %d bytes", maxEventLogXPathBytes),
			time.Since(startTime).Milliseconds(),
		)
	}
	if xpathQuery != "" && (level != "" || source != "" || eventID > 0) {
		return NewErrorResult(
			fmt.Errorf("query (XPath) cannot be combined with the level, source, or eventId filters; put the conditions in the XPath expression instead"),
			time.Since(startTime).Milliseconds(),
		)
	}

	if page < 1 {
		page = 1
	}
	if page > maxEventLogQueryPage {
		page = maxEventLogQueryPage
	}
	if limit < 1 || limit > 500 {
		limit = 50
	}

	return queryEventLogsOS(logName, level, source, xpathQuery, eventID, page, limit, startTime)
}

// GetEventLogEntry returns a specific event log entry
func GetEventLogEntry(payload map[string]any) CommandResult {
	startTime := time.Now()

	logName, _ := truncateStringBytes(GetPayloadString(payload, "logName", "System"), maxEventLogFieldBytes)
	recordID := GetPayloadInt(payload, "recordId", 0)

	return getEventLogEntryOS(logName, int64(recordID), startTime)
}
