//go:build windows

package terminal

import (
	"log/slog"
	"os"
)

// forwardSignal sends an interrupt signal to the shell process.
// On Windows, syscall.Kill doesn't exist. We use os.Process.Signal
// with os.Interrupt to send a CTRL_BREAK_EVENT to the process.
// Only Ctrl+C (SIGINT equivalent) is supported; Ctrl+\ and Ctrl+Z
// have no direct Windows equivalents for console processes.
func (s *Session) forwardSignal(b byte) {
	if s.cmd == nil || s.cmd.Process == nil {
		return
	}
	switch b {
	case 0x03: // Ctrl+C
		if err := s.cmd.Process.Signal(os.Interrupt); err != nil {
			slog.Debug("failed to send interrupt signal", "pid", s.cmd.Process.Pid, "error", err.Error())
		}
	}
}
