//go:build !linux && !darwin && !windows

package heartbeat

import "fmt"

// installAndRestartWatchdog is unsupported on platforms without a breeze-watchdog
// service. The agent only ships a watchdog on Linux, macOS, and Windows.
func (h *Heartbeat) installAndRestartWatchdog(targetVersion string) error {
	return fmt.Errorf("watchdog auto-update is not supported on this platform")
}
