//go:build linux

package heartbeat

import (
	"errors"
	"os"
	"os/exec"
	"time"
)

func watchdogExecutableName() string { return "breeze-watchdog" }

// registerVerifiedWatchdog runs the verified watchdog's own `service install`
// through a systemd-run transient service (see watchdogInstallTransientArgs).
func registerVerifiedWatchdog(stagedPath string) error {
	if _, err := exec.LookPath("systemd-run"); err != nil {
		return errors.New("systemd-run is unavailable")
	}
	args := watchdogInstallTransientArgs(os.Getpid(), time.Now().UnixNano(), stagedPath)
	// Our own deadline sits above the unit's RuntimeMaxSec so systemd, not a
	// killed systemd-run client, is what ends a hung installer.
	return runWatchdogInstallCommand(watchdogRegisterTimeout+30*time.Second, "systemd-run", args...)
}

// waitWatchdogRunning polls `systemctl is-active breeze-watchdog`.
func waitWatchdogRunning(timeout time.Duration) bool {
	return pollWatchdogRunning(timeout, func() bool {
		return exec.Command("systemctl", "is-active", "--quiet", "breeze-watchdog").Run() == nil
	})
}
