//go:build linux

package collectors

import (
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"sync"
)

// hostHasSystemd reports whether systemd is PID-1 init on this host. Same test
// as sd_booted(3): /run/systemd/system exists. Cached for process life: init
// cannot change without a reboot.
var hostHasSystemd = sync.OnceValue(func() bool {
	if systemdBooted("/run/systemd/system") {
		return true
	}
	slog.Debug("systemd is not the init system; skipping journalctl/systemctl collection")
	return false
})

// systemdBooted treats only a definite absence as "no systemd". The answer is
// cached for process life and an empty service list replaces the last snapshot,
// so a stat that fails any other way must leave collection running.
func systemdBooted(runDir string) bool {
	info, err := os.Stat(runDir)
	if err != nil {
		return !errors.Is(err, fs.ErrNotExist)
	}
	return info.IsDir()
}
