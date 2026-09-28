//go:build !windows

package rebuild

import (
	"errors"
	"os"
	"syscall"
)

// NewWinSystem is unavailable off Windows — mirrors NewSystem's !linux stub
// (system_other.go). The real implementation is winsystem_windows.go.
func NewWinSystem() WinSystem { return nil }

func init() {
	// hostWindowsDir (win_boot.go): no real host Windows directory off
	// Windows; hostSystemTool's C:\Windows fallback applies.
	hostWindowsDir = func() string { return "" }
	processAlive = unixProcessAlive
}

// unixProcessAlive: signal 0 probes without delivering anything. Only "no
// such process" means dead — EPERM (another user's process) is alive.
func unixProcessAlive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = p.Signal(syscall.Signal(0))
	return !errors.Is(err, os.ErrProcessDone) && !errors.Is(err, syscall.ESRCH)
}
