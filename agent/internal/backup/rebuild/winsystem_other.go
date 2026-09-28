//go:build !windows

package rebuild

import (
	"errors"
	"os"
	"syscall"
	"time"
)

// NewWinSystem is unavailable off Windows — mirrors NewSystem's !linux stub
// (system_other.go). The real implementation is winsystem_windows.go.
func NewWinSystem() WinSystem { return nil }

func init() {
	// hostWindowsDir (win_boot.go): no real host Windows directory off
	// Windows; hostSystemTool's C:\Windows fallback applies.
	hostWindowsDir = func() string { return "" }
	processState = unixProcessState
}

// unixProcessState: signal 0 probes without delivering anything. Only "no
// such process" means not running — EPERM (another user's process) is
// running. The start time is not read here (zero = unknown).
func unixProcessState(pid int) (bool, time.Time) {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false, time.Time{}
	}
	err = p.Signal(syscall.Signal(0))
	return !errors.Is(err, os.ErrProcessDone) && !errors.Is(err, syscall.ESRCH), time.Time{}
}
