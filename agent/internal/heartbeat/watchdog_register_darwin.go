//go:build darwin

package heartbeat

import (
	"os/exec"
	"strings"
	"time"
)

func watchdogExecutableName() string { return "breeze-watchdog" }

// registerVerifiedWatchdog runs the verified (and code-signature-checked)
// watchdog's own `service install`. The agent is a root LaunchDaemon with no
// mount sandbox, so it execs it directly.
func registerVerifiedWatchdog(stagedPath string) error {
	return runWatchdogInstallCommand(watchdogRegisterTimeout, stagedPath, "service", "install")
}

// waitWatchdogRunning polls launchd for the watchdog job's state.
func waitWatchdogRunning(timeout time.Duration) bool {
	return pollWatchdogRunning(timeout, func() bool {
		out, err := exec.Command("launchctl", "print", "system/"+watchdogLaunchdLabel).Output()
		return err == nil && strings.Contains(string(out), "state = running")
	})
}
