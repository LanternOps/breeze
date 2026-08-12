//go:build windows

package patching

import (
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// execOSReboot starts the Windows shutdown countdown. The argument construction
// (including the seconds-vs-minutes conversion) lives in the untagged
// windowsRebootArgs so it is covered by tests that actually run in CI.
func execOSReboot(grace time.Duration) error {
	args := windowsRebootArgs(grace)
	out, err := exec.Command("shutdown", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("shutdown %s: %w (%s)", strings.Join(args, " "), err, string(out))
	}
	return nil
}

// abortOSReboot aborts a countdown started by execOSReboot.
func abortOSReboot() error {
	out, err := exec.Command("shutdown", "/a").CombinedOutput()
	if err != nil {
		return fmt.Errorf("shutdown /a: %w (%s)", err, string(out))
	}
	return nil
}
