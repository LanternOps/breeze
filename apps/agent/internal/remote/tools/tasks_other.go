//go:build !windows

package tools

import (
	"runtime"
)

// ListTasks is not supported on non-Windows platforms.
func (m *TaskSchedulerManager) ListTasks(folder string) ([]ScheduledTask, error) {
	return nil, newPlatformError("ListTasks")
}

// GetTask is not supported on non-Windows platforms.
func (m *TaskSchedulerManager) GetTask(path string) (*TaskDetails, error) {
	return nil, newPlatformError("GetTask")
}

// RunTask is not supported on non-Windows platforms.
func (m *TaskSchedulerManager) RunTask(path string) error {
	return newPlatformError("RunTask")
}

// EnableTask is not supported on non-Windows platforms.
func (m *TaskSchedulerManager) EnableTask(path string) error {
	return newPlatformError("EnableTask")
}

// DisableTask is not supported on non-Windows platforms.
func (m *TaskSchedulerManager) DisableTask(path string) error {
	return newPlatformError("DisableTask")
}

// GetTaskHistory is not supported on non-Windows platforms.
func (m *TaskSchedulerManager) GetTaskHistory(path string, limit int) ([]TaskHistory, error) {
	return nil, newPlatformError("GetTaskHistory")
}

// IsSupported returns true if the Task Scheduler is supported on the current platform.
func (m *TaskSchedulerManager) IsSupported() bool {
	return runtime.GOOS == "windows"
}
