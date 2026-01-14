//go:build !windows

package tools

import (
	"errors"
	"fmt"
	"runtime"
)

// ErrNotSupported is returned when Windows-only operations are attempted on a non-Windows platform.
var ErrNotSupported = errors.New("this operation is only supported on Windows")

// PlatformError represents an error when an operation is not supported on the current platform.
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

// newPlatformError creates a formatted error for unsupported platform operations.
func newPlatformError(operation string) error {
	return &PlatformError{
		Operation: operation,
		Platform:  runtime.GOOS,
		Message:   "Windows-only feature",
	}
}
