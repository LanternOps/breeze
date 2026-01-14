//go:build !windows

package tools

// ListLogs returns an error on non-Windows platforms.
func (m *EventLogManager) ListLogs() ([]EventLog, error) {
	return nil, newEventLogPlatformError("ListLogs")
}

// GetLogInfo returns an error on non-Windows platforms.
func (m *EventLogManager) GetLogInfo(logName string) (*EventLog, error) {
	return nil, newEventLogPlatformError("GetLogInfo")
}

// QueryEvents returns an error on non-Windows platforms.
func (m *EventLogManager) QueryEvents(logName string, filter EventFilter) (*EventQueryResult, error) {
	return nil, newEventLogPlatformError("QueryEvents")
}

// GetEvent returns an error on non-Windows platforms.
func (m *EventLogManager) GetEvent(logName string, recordId uint64) (*EventLogEntry, error) {
	return nil, newEventLogPlatformError("GetEvent")
}

// ClearLog returns an error on non-Windows platforms.
func (m *EventLogManager) ClearLog(logName string, options *ClearLogOptions) error {
	return newEventLogPlatformError("ClearLog")
}

func newEventLogPlatformError(operation string) *EventLogPlatformError {
	return &EventLogPlatformError{Operation: operation}
}

// EventLogPlatformError represents an error when event log operations are attempted on non-Windows platforms.
type EventLogPlatformError struct {
	Operation string
}

func (e *EventLogPlatformError) Error() string {
	return "event log " + e.Operation + " is not supported: Windows Event Log requires Windows"
}
