//go:build darwin

package patching

import (
	"fmt"
	"time"
)

// execOSReboot starts the macOS shutdown countdown.
//
// BSD shutdown(8) takes `+N` in MINUTES, same as Linux. It is run with a
// non-zero grace for the same reason: the closing desktop toast needs to render
// before the session goes away.
func execOSReboot(grace time.Duration) error {
	return runRebootCommand("shutdown", unixRebootArgs(grace)...)
}

// abortOSReboot cannot be honoured on macOS: BSD shutdown(8) has no cancel
// flag. Returning an error rather than nil keeps Cancel() honest — the Go-side
// timers are cleared either way, so this is only reachable in the final minute
// after the OS countdown has already started.
func abortOSReboot() error {
	return fmt.Errorf("macOS shutdown(8) has no cancel flag; the OS countdown cannot be aborted once started")
}
