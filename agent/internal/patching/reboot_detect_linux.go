//go:build linux

package patching

import (
	"errors"
	"os"
	"os/exec"
	"time"
)

var linuxNeedsRestarting = &nrCache{ttl: 30 * time.Minute, run: runNeedsRestarting}

// DetectPendingReboot reports whether the OS indicates a pending reboot.
func DetectPendingReboot() (bool, []string) {
	return detectPendingRebootLinux(os.Stat, linuxNeedsRestarting.get)
}

// runNeedsRestarting executes `needs-restarting -r` (RHEL/dnf-utils).
// Exit 0 = no reboot needed, exit 1 = reboot needed, anything else (or the
// tool being absent) = no signal.
func runNeedsRestarting() (bool, bool) {
	path, err := exec.LookPath("needs-restarting")
	if err != nil {
		return false, false
	}
	runErr := exec.Command(path, "-r").Run()
	if runErr == nil {
		return false, true
	}
	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) && exitErr.ExitCode() == 1 {
		return true, true
	}
	return false, false
}
