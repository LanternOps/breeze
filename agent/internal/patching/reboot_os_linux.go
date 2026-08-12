//go:build linux

package patching

import (
	"fmt"
	"os/exec"
	"strings"
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
	args := unixRebootArgs(grace)
	out, err := exec.Command("shutdown", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("shutdown %s: %w (%s)", strings.Join(args, " "), err, string(out))
	}
	return nil
}

// abortOSReboot cancels a pending `shutdown` on Linux.
func abortOSReboot() error {
	out, err := exec.Command("shutdown", "-c").CombinedOutput()
	if err != nil {
		return fmt.Errorf("shutdown -c: %w (%s)", err, string(out))
	}
	return nil
}
