//go:build linux

package heartbeat

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// installAndRestartWatchdog downloads the verified watchdog binary, swaps it in
// place, and restarts the breeze-watchdog systemd service so the new binary is
// re-exec'd. The agent runs as root, so it has rights over /usr/local/bin and
// systemctl.
func (h *Heartbeat) installAndRestartWatchdog(targetVersion string) error {
	tempPath, err := h.downloadWatchdogBinary(targetVersion)
	if err != nil {
		return fmt.Errorf("download watchdog: %w", err)
	}
	defer func() { _ = os.Remove(tempPath) }()

	if err := replaceWatchdogBinaryUnix(tempPath, watchdogBinaryPathUnix); err != nil {
		return err
	}

	if out, err := exec.Command("systemctl", "restart", "breeze-watchdog").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl restart breeze-watchdog: %s: %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}
