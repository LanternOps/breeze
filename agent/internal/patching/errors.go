package patching

import "fmt"

// ErrPreflightFailed indicates a pre-flight check failed before patching could proceed.
type ErrPreflightFailed struct {
	Check   string // e.g. "disk_space", "battery", "service_health", "maintenance_window"
	Message string
}

func (e *ErrPreflightFailed) Error() string {
	return fmt.Sprintf("preflight check %q failed: %s", e.Check, e.Message)
}

// ErrRebootLoopDetected indicates too many reboots have occurred within a time window.
type ErrRebootLoopDetected struct {
	Count  int
	Window string // human-readable window, e.g. "24h"
}

func (e *ErrRebootLoopDetected) Error() string {
	return fmt.Sprintf("reboot loop detected: %d reboots in %s", e.Count, e.Window)
}
