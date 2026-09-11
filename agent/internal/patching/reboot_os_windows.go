//go:build windows

package patching

import (
	"time"
)

// execOSReboot starts the Windows shutdown countdown. The argument construction
// (including the seconds-vs-minutes conversion) lives in the untagged
// windowsRebootArgs so it is covered by tests that actually run in CI.
func execOSReboot(grace time.Duration) error {
	return runRebootCommand("shutdown", windowsRebootArgs(grace)...)
}

// abortOSReboot aborts a countdown started by execOSReboot.
func abortOSReboot() error {
	return runRebootCommand("shutdown", "/a")
}
