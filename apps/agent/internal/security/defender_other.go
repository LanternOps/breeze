//go:build !windows

package security

import (
	"fmt"
	"runtime"
)

// PlatformError represents an error for unsupported platform operations.
type PlatformError struct {
	Operation string
	Platform  string
	Message   string
}

func (e *PlatformError) Error() string {
	return fmt.Sprintf("%s is not supported on %s: %s", e.Operation, e.Platform, e.Message)
}

func (e *PlatformError) Is(target error) bool {
	return target == ErrNotSupported
}

func newPlatformError(operation string) error {
	return &PlatformError{
		Operation: operation,
		Platform:  runtime.GOOS,
		Message:   "Windows-only feature",
	}
}

// GetDefenderStatus returns an error on non-Windows platforms.
func GetDefenderStatus() (DefenderStatus, error) {
	return DefenderStatus{}, newPlatformError("GetDefenderStatus")
}

// TriggerDefenderScan returns an error on non-Windows platforms.
func TriggerDefenderScan(scanType string) error {
	return newPlatformError("TriggerDefenderScan")
}
