//go:build darwin

package isolation

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// systemMono is CLOCK_MONOTONIC, which on macOS is mach_continuous_time:
// monotonic and counting sleep.
func systemMono() time.Duration {
	var ts unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_MONOTONIC, &ts); err != nil {
		return processMono()
	}
	return time.Duration(ts.Nano())
}

var bootIDOnce = sync.OnceValue(func() string {
	if id, err := unix.Sysctl("kern.bootsessionuuid"); err == nil && strings.TrimSpace(id) != "" {
		return "darwin:" + strings.TrimSpace(id)
	}
	if tv, err := unix.SysctlTimeval("kern.boottime"); err == nil {
		return fmt.Sprintf("darwin-boottime:%d", tv.Sec)
	}
	return processBootID()
})

func systemBootID() string { return bootIDOnce() }
