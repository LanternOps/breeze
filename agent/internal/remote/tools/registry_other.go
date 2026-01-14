//go:build !windows

package tools

import (
	"fmt"
	"time"
)

func listRegistryKeysOS(hive, path string, startTime time.Time) CommandResult {
	return NewErrorResult(
		fmt.Errorf("registry is only supported on Windows"),
		time.Since(startTime).Milliseconds(),
	)
}

func listRegistryValuesOS(hive, path string, startTime time.Time) CommandResult {
	return NewErrorResult(
		fmt.Errorf("registry is only supported on Windows"),
		time.Since(startTime).Milliseconds(),
	)
}

func getRegistryValueOS(hive, path, name string, startTime time.Time) CommandResult {
	return NewErrorResult(
		fmt.Errorf("registry is only supported on Windows"),
		time.Since(startTime).Milliseconds(),
	)
}

func setRegistryValueOS(hive, path, name, valueType, data string, startTime time.Time) CommandResult {
	return NewErrorResult(
		fmt.Errorf("registry is only supported on Windows"),
		time.Since(startTime).Milliseconds(),
	)
}

func deleteRegistryValueOS(hive, path, name string, startTime time.Time) CommandResult {
	return NewErrorResult(
		fmt.Errorf("registry is only supported on Windows"),
		time.Since(startTime).Milliseconds(),
	)
}
