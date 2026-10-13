//go:build !linux && !darwin && !windows

package watchdoginstall

// Detect: the watchdog ships only for Linux (systemd), macOS and Windows.
func Detect(StatFunc) Status { return StatusUnsupported }
