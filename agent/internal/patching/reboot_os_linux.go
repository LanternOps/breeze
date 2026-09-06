//go:build linux

package patching

import (
	"time"
)

// execOSReboot starts the Linux shutdown countdown.
//
// `shutdown -r +N` takes MINUTES and also broadcasts a wall message to logged-in
// terminal sessions, which is a second delivery path alongside the desktop toast
// the RebootManager already sent. `+0`/`now` is deliberately never used: it
// would reintroduce, on Linux, exactly the fire-the-toast-then-kill-the-session
// race that #3197 fixes on Windows.
func execOSReboot(grace time.Duration) error {
	return runRebootCommand("shutdown", unixRebootArgs(grace)...)
}

// abortOSReboot cancels a pending `shutdown` on Linux.
func abortOSReboot() error {
	return runRebootCommand("shutdown", "-c")
}
