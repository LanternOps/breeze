//go:build !windows

package tools

import (
	"fmt"
	"time"
)

func listEventLogsOS(startTime time.Time) CommandResult {
	return NewErrorResult(
		fmt.Errorf("event logs are only supported on Windows"),
		time.Since(startTime).Milliseconds(),
	)
}

func queryEventLogsOS(logName, level, source string, eventID, page, limit int, startTime time.Time) CommandResult {
	return NewErrorResult(
		fmt.Errorf("event logs are only supported on Windows"),
		time.Since(startTime).Milliseconds(),
	)
}

func getEventLogEntryOS(logName string, recordID int64, startTime time.Time) CommandResult {
	return NewErrorResult(
		fmt.Errorf("event logs are only supported on Windows"),
		time.Since(startTime).Milliseconds(),
	)
}
