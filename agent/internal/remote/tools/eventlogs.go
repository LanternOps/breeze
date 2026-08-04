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
	source, _ := truncateStringBytes(GetPayloadString(payload, "source", ""), maxEventLogFieldBytes)
	eventID := GetPayloadInt(payload, "eventId", 0)
	page := GetPayloadInt(payload, "page", 1)
	limit := GetPayloadInt(payload, "limit", 50)

	// Filters are applied verbatim or rejected — never coerced, truncated, or
	// silently dropped (issue #3092: callers received confidently unfiltered
	// results when a filter didn't take effect).
	if raw, ok := payload["query"]; ok {
		if _, isString := raw.(string); !isString {
			return NewErrorResult(
				fmt.Errorf("query must be a string containing an XPath expression"),
				time.Since(startTime).Milliseconds(),
			)
		}
	}
	xpathQuery := strings.TrimSpace(GetPayloadString(payload, "query", ""))
	if len(xpathQuery) > maxEventLogXPathBytes {
		return NewErrorResult(
			fmt.Errorf("query exceeds the maximum XPath length of %d bytes", maxEventLogXPathBytes),
			time.Since(startTime).Milliseconds(),
		)
	}

	levelNum, levelErr := parseEventLogLevel(payload)
	if levelErr != nil {
		return NewErrorResult(levelErr, time.Since(startTime).Milliseconds())
	}

	if xpathQuery != "" && (levelNum > 0 || source != "" || eventID > 0) {
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

	return queryEventLogsOS(logName, source, xpathQuery, levelNum, eventID, page, limit, startTime)
}

// parseEventLogLevel resolves the "level" payload value to a Windows event
// level number (1=Critical … 5=Verbose), or 0 when no level filter was
// requested. Unknown level names, out-of-range numbers, and other types are
// rejected with an explicit error instead of being silently dropped from the
// filter (issue #3092).
func parseEventLogLevel(payload map[string]any) (int, error) {
	raw, ok := payload["level"]
	if !ok {
		return 0, nil
	}
	switch v := raw.(type) {
	case string:
		if v == "" {
			return 0, nil
		}
		if n := levelToNumber(v); n > 0 {
			return n, nil
		}
		return 0, fmt.Errorf("unknown level %q; accepted values: critical, error, warning, information, verbose, or 1-5", v)
	case int, int64, float64:
		n := GetPayloadInt(payload, "level", 0)
		if f, isFloat := v.(float64); isFloat && f != float64(n) {
			return 0, fmt.Errorf("level %v is not a whole number; accepted values: 1 (critical) through 5 (verbose)", v)
		}
		if n < 1 || n > 5 {
			return 0, fmt.Errorf("level %v is out of range; accepted values: 1 (critical) through 5 (verbose)", v)
		}
		return n, nil
	default:
		return 0, fmt.Errorf("level must be a string or a number")
	}
}

// GetEventLogEntry returns a specific event log entry
func GetEventLogEntry(payload map[string]any) CommandResult {
	startTime := time.Now()

	logName, _ := truncateStringBytes(GetPayloadString(payload, "logName", "System"), maxEventLogFieldBytes)
	recordID := GetPayloadInt(payload, "recordId", 0)

	return getEventLogEntryOS(logName, int64(recordID), startTime)
}
