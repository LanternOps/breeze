//go:build windows

package sessionbroker

import (
	"fmt"
	"net"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// SDDL: SYSTEM gets full control, Interactive Users get read/write.
// IU (Interactive Users) restricts to users logged in interactively —
// excludes service accounts, batch jobs, and network logons.
const pipeSecurity = "D:P(A;;GA;;;SY)(A;;GRGW;;;IU)"

func (b *Broker) setupSocket() (net.Listener, error) {
	cfg := &winio.PipeConfig{
		SecurityDescriptor: pipeSecurity,
		InputBufferSize:    64 * 1024,
		OutputBufferSize:   64 * 1024,
	}

	listener, err := winio.ListenPipe(b.socketPath, cfg)
	if err != nil {
		return nil, fmt.Errorf("listen pipe %s: %w", b.socketPath, err)
	}
	log.Info("named pipe listener created", "pipe", b.socketPath)
	return listener, nil
}

// peerWinSessionID returns the Windows session ID for the given process,
// verified by the kernel via ProcessIdToSessionId. Returns 0 on failure.
func peerWinSessionID(pid int) uint32 {
	if pid <= 0 {
		return 0
	}
	var sessionID uint32
	if err := windows.ProcessIdToSessionId(uint32(pid), &sessionID); err != nil {
		return 0
	}
	return sessionID
}
