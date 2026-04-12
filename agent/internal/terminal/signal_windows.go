//go:build windows

package terminal

import (
	"log/slog"
	"os"
	"sync/atomic"
)

// forwardSignal sends an interrupt signal to the shell process.
// When ConPTY is active, control characters are handled natively by the
// pseudo console — writing 0x03 to the input pipe is sufficient for Ctrl+C.
// This function only acts in the legacy pipe mode.
func (s *Session) forwardSignal(b byte) {
	// ConPTY handles control characters natively through the pseudo console.
	if atomic.LoadUintptr(&s.hConPty) != 0 {
		return
	}
	// Legacy pipe mode fallback — only Ctrl+C is supported.
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
