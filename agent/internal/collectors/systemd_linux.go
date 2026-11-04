//go:build linux

package collectors

import (
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

func systemdBooted(runDir string) bool {
	info, err := os.Stat(runDir)
	return err == nil && info.IsDir()
}
