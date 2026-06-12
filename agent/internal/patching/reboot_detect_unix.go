// This file is intentionally untagged: nrCache and detectPendingRebootLinux
// are referenced only from reboot_detect_linux.go (//go:build linux), but
// keeping them untagged lets reboot_detect_unix_test.go run on any dev
// platform.
package patching

import (
	"os"
	"sync"
	"time"
)

// linuxRebootMarkers are distro-written marker files whose presence means a
// reboot is required (Debian/Ubuntu apt writes /var/run/reboot-required).
var linuxRebootMarkers = []string{
	"/var/run/reboot-required",
}

// nrCache memoizes the needs-restarting result: the command can take seconds
// on RHEL-family systems and heartbeats run every cycle.
type nrCache struct {
	mu  sync.Mutex
	ttl time.Duration
	at  time.Time
	val bool
	ok  bool
	run func() (bool, bool)
}

func (c *nrCache) get() (bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.at.IsZero() && time.Since(c.at) < c.ttl {
		return c.val, c.ok
	}
	c.val, c.ok = c.run()
	c.at = time.Now()
	return c.val, c.ok
}

// detectPendingRebootLinux is the testable core of the Linux detector. Kept
// untagged (with injected deps) so its tests run on any dev platform; the
// //go:build linux wrapper in reboot_detect_linux.go wires the real deps.
func detectPendingRebootLinux(stat func(string) (os.FileInfo, error), nr func() (bool, bool)) (bool, []string) {
	var reasons []string
	for _, p := range linuxRebootMarkers {
		if _, err := stat(p); err == nil {
			reasons = append(reasons, "reboot-required marker present: "+p)
		}
	}
	if len(reasons) == 0 {
		if needed, ok := nr(); ok && needed {
			reasons = append(reasons, "needs-restarting reports reboot required")
		}
	}
	return len(reasons) > 0, reasons
}
