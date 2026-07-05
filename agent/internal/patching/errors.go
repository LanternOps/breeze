package patching

import (
	"errors"
	"fmt"
)

// ErrScanSkipped is a sentinel a provider's Scan returns when the provider
// could not run at all (e.g. winget with no connected user helper session).
// Skipped is distinct from "scanned and found nothing": the server must not
// tombstone a skipped provider's previously reported patches, so skipped
// providers are excluded from scan coverage (see PatchManager.ScanWithCoverage).
var ErrScanSkipped = errors.New("patch provider scan skipped")

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
