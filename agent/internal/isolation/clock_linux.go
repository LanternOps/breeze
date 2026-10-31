//go:build linux

package isolation

import (
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// systemMono is CLOCK_BOOTTIME: monotonic and counting suspend.
func systemMono() time.Duration {
	var ts unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_BOOTTIME, &ts); err != nil {
		return processMono()
	}
	return time.Duration(ts.Nano())
}

var bootIDOnce = sync.OnceValue(func() string {
	data, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if id := strings.TrimSpace(string(data)); err == nil && id != "" {
		return "linux:" + id
	}
	return processBootID()
})

func systemBootID() string { return bootIDOnce() }
