//go:build !windows && !linux && !darwin

package patching

import (
	"fmt"
	"runtime"
	"time"
)

// execOSReboot has no implementation outside windows/linux/darwin. Returning an
// error rather than nil is the point: the pre-#3197 non-Windows stub returned
// nil from Schedule() and did nothing, so the API recorded a clean reboot on a
// device that never restarted.
func execOSReboot(_ time.Duration) error {
	return fmt.Errorf("scheduled reboot is not implemented on %s", runtime.GOOS)
}

func abortOSReboot() error {
	return fmt.Errorf("scheduled reboot is not implemented on %s", runtime.GOOS)
}
