//go:build !windows

package main

import (
	"os"
	"os/exec"

	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"
)

// recoveryKernelCmdlineFile is the Linux media's cmdline source.
const recoveryKernelCmdlineFile = "/proc/cmdline"

// defaultConsoleHost is the Linux live-media host (W04b): /proc/cmdline,
// the baked /etc/breeze-recovery-* files, the system root store, lsblk
// layout collection, systemctl power and the media's own shell, plus the
// tty1/ttyS0 console lock. HostCheck refuses wherever the Linux rebuild
// engine has no System (every non-Linux, non-Windows host).
func defaultConsoleHost() consoleHost {
	sys := rebuild.NewSystem()
	return consoleHost{
		Cmdline: func() (string, error) {
			// Unreadable reads as empty, as it always has: the guard
			// then refuses unless --allow-host.
			raw, _ := os.ReadFile(recoveryKernelCmdlineFile)
			return string(raw), nil
		},
		BakedServer:   recoveryBakedServerFile,
		BakedTrustPin: recoveryBakedTrustPinFile,
		BakedRoots:    "",
		Collect:       layout.Collect,
		MediaSources: func() ([]string, error) {
			if sys == nil {
				return nil, rebuild.ErrUnsupportedHost
			}
			return sys.RootSources()
		},
		Power: func(action string) error {
			return exec.Command("systemctl", action).Run()
		},
		Shell:       runRecoveryShell,
		AcquireLock: acquireRecoveryConsoleLock,
		HostCheck: func() error {
			if sys == nil {
				return rebuild.ErrUnsupportedHost
			}
			return nil
		},
	}
}
