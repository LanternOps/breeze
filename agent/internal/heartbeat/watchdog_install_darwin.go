//go:build darwin

package heartbeat

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// watchdogLaunchdLabel is the launchd label of the watchdog LaunchDaemon
// (matches breeze-watchdog's own service install).
const watchdogLaunchdLabel = "com.breeze.watchdog"

// installAndRestartWatchdog downloads the verified watchdog binary, swaps it in
// place, and kickstarts the watchdog LaunchDaemon so the new binary is
// re-exec'd. The agent runs as root (system domain), so it has rights over
// /usr/local/bin and launchctl.
func (h *Heartbeat) installAndRestartWatchdog(targetVersion string) error {
	tempPath, err := h.downloadWatchdogBinary(targetVersion)
	if err != nil {
		return fmt.Errorf("download watchdog: %w", err)
	}
	defer func() { _ = os.Remove(tempPath) }()

	if err := replaceWatchdogBinaryUnix(tempPath, watchdogBinaryPathUnix); err != nil {
		return err
	}

	if out, err := exec.Command("launchctl", "kickstart", "-k", "system/"+watchdogLaunchdLabel).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl kickstart %s: %s: %w", watchdogLaunchdLabel, strings.TrimSpace(string(out)), err)
	}
	return nil
}
