//go:build !windows

package tools

import (
	"fmt"
	"time"
)

func listTasksOS(folder, search string, page, limit int, startTime time.Time) CommandResult {
	return NewErrorResult(
		fmt.Errorf("scheduled tasks are only supported on Windows"),
		time.Since(startTime).Milliseconds(),
	)
}

func getTaskOS(path string, startTime time.Time) CommandResult {
	return NewErrorResult(
		fmt.Errorf("scheduled tasks are only supported on Windows"),
		time.Since(startTime).Milliseconds(),
	)
}

func runTaskOS(path string, startTime time.Time) CommandResult {
	return NewErrorResult(
		fmt.Errorf("scheduled tasks are only supported on Windows"),
		time.Since(startTime).Milliseconds(),
	)
}

func enableTaskOS(path string, startTime time.Time) CommandResult {
	return NewErrorResult(
		fmt.Errorf("scheduled tasks are only supported on Windows"),
		time.Since(startTime).Milliseconds(),
	)
}

func disableTaskOS(path string, startTime time.Time) CommandResult {
	return NewErrorResult(
		fmt.Errorf("scheduled tasks are only supported on Windows"),
		time.Since(startTime).Milliseconds(),
	)
}
