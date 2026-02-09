//go:build windows

package sessionbroker

import (
	"fmt"

	"github.com/Microsoft/go-winio"
)

// SDDL: SYSTEM gets full control, Interactive Users get read/write.
// IU (Interactive Users) restricts to users logged in interactively —
// excludes service accounts, batch jobs, and network logons.
const pipeSecurity = "D:P(A;;GA;;;SY)(A;;GRGW;;;IU)"

func (b *Broker) setupSocket() error {
	cfg := &winio.PipeConfig{
		SecurityDescriptor: pipeSecurity,
		InputBufferSize:    64 * 1024,
		OutputBufferSize:   64 * 1024,
	}

	listener, err := winio.ListenPipe(b.socketPath, cfg)
	if err != nil {
		return fmt.Errorf("listen pipe %s: %w", b.socketPath, err)
	}

	b.listener = listener
	log.Info("named pipe listener created", "pipe", b.socketPath)
	return nil
}
