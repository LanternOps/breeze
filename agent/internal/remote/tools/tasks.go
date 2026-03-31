package tools

import (
	"fmt"
	"strings"
	"time"
)

func validateTaskFolder(folder string) (string, error) {
	folder = strings.TrimSpace(folder)
	if folder == "" {
		return "\\", nil
	}
	if _, truncated := truncateStringBytes(folder, maxRegistryPathBytes); truncated {
		return "", fmt.Errorf("task folder exceeds maximum length of %d bytes", maxRegistryPathBytes)
	}
	if !strings.HasPrefix(folder, "\\") {
		return "", fmt.Errorf("task folder must start with '\\\\'")
	}
	if strings.Contains(folder, "..") || strings.ContainsAny(folder, "\x00\r\n") {
		return "", fmt.Errorf("task folder contains invalid characters")
	}
	return folder, nil
}

func validateTaskPath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", fmt.Errorf("task path is required")
	}
	if _, truncated := truncateStringBytes(path, maxRegistryPathBytes); truncated {
		return "", fmt.Errorf("task path exceeds maximum length of %d bytes", maxRegistryPathBytes)
	}
	if !strings.HasPrefix(path, "\\") {
		return "", fmt.Errorf("task path must start with '\\\\'")
	}
	if strings.Contains(path, "..") || strings.ContainsAny(path, "\x00\r\n") {
		return "", fmt.Errorf("task path contains invalid characters")
	}
	return path, nil
}

// ListTasks returns a list of scheduled tasks
func ListTasks(payload map[string]any) CommandResult {
	startTime := time.Now()

	folder := GetPayloadString(payload, "folder", "\\")
	search := GetPayloadString(payload, "search", "")
	page := GetPayloadInt(payload, "page", 1)
	limit := GetPayloadInt(payload, "limit", 50)
	var err error
	folder, err = validateTaskFolder(folder)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}
	search, _ = truncateStringBytes(search, maxTaskFieldBytes)

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
	var err error
	path, err = validateTaskPath(path)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}
	return getTaskOS(path, startTime)
}

// RunTask triggers a scheduled task to run
func RunTask(payload map[string]any) CommandResult {
	startTime := time.Now()
	path := GetPayloadString(payload, "path", "")
	var err error
	path, err = validateTaskPath(path)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}
	return runTaskOS(path, startTime)
}

// EnableTask enables a disabled scheduled task
func EnableTask(payload map[string]any) CommandResult {
	startTime := time.Now()
	path := GetPayloadString(payload, "path", "")
	var err error
	path, err = validateTaskPath(path)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}
	return enableTaskOS(path, startTime)
}

// DisableTask disables a scheduled task
func DisableTask(payload map[string]any) CommandResult {
	startTime := time.Now()
	path := GetPayloadString(payload, "path", "")
	var err error
	path, err = validateTaskPath(path)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}
	return disableTaskOS(path, startTime)
}

// GetTaskHistory returns recent task scheduler history for a task path
func GetTaskHistory(payload map[string]any) CommandResult {
	startTime := time.Now()
	path := GetPayloadString(payload, "path", "")
	var err error
	path, err = validateTaskPath(path)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}
	limit := GetPayloadInt(payload, "limit", 50)
	if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}
	return getTaskHistoryOS(path, limit, startTime)
}
