//go:build !windows

package tools

import (
	"fmt"
	"time"
)

// RebootToSafeMode is not supported on non-Windows platforms.
func RebootToSafeMode(payload map[string]any) CommandResult {
	startTime := time.Now()
	return NewErrorResult(fmt.Errorf("reboot to safe mode is only supported on Windows"), time.Since(startTime).Milliseconds())
}
