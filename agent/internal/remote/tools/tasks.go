package tools

import (
	"time"
)

// ListTasks returns a list of scheduled tasks
func ListTasks(payload map[string]any) CommandResult {
	startTime := time.Now()

	folder := GetPayloadString(payload, "folder", "\\")
	search := GetPayloadString(payload, "search", "")
	page := GetPayloadInt(payload, "page", 1)
	limit := GetPayloadInt(payload, "limit", 50)

	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 500 {
		limit = 50
	}

	return listTasksOS(folder, search, page, limit, startTime)
}

// GetTask returns details for a specific scheduled task
func GetTask(payload map[string]any) CommandResult {
	startTime := time.Now()
	path := GetPayloadString(payload, "path", "")
	return getTaskOS(path, startTime)
}

// RunTask triggers a scheduled task to run
func RunTask(payload map[string]any) CommandResult {
	startTime := time.Now()
	path := GetPayloadString(payload, "path", "")
	return runTaskOS(path, startTime)
}

// EnableTask enables a disabled scheduled task
func EnableTask(payload map[string]any) CommandResult {
	startTime := time.Now()
	path := GetPayloadString(payload, "path", "")
	return enableTaskOS(path, startTime)
}

// DisableTask disables a scheduled task
func DisableTask(payload map[string]any) CommandResult {
	startTime := time.Now()
	path := GetPayloadString(payload, "path", "")
	return disableTaskOS(path, startTime)
}
