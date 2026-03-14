//go:build !windows

package terminal

import (
	"log/slog"
	"syscall"
)

// forwardSignal sends a signal to the shell's process group.
// On macOS LaunchDaemons (and potentially Linux services), the shell may not
// have a controlling terminal, so the PTY line discipline can't deliver signals.
// We manually forward control characters as signals to the process group.
func (s *Session) forwardSignal(b byte) {
	if s.cmd == nil || s.cmd.Process == nil {
		return
	}
	pid := s.cmd.Process.Pid
	var sig syscall.Signal
	switch b {
	case 0x03: // Ctrl+C
		sig = syscall.SIGINT
	case 0x1c: // Ctrl+\
		sig = syscall.SIGQUIT
	case 0x1a: // Ctrl+Z
		sig = syscall.SIGTSTP
	default:
		return
	}
	if err := syscall.Kill(-pid, sig); err != nil {
		slog.Debug("failed to forward signal to process group", "pid", pid, "signal", sig, "error", err.Error())
	}
}
