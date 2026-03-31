//go:build !windows

package sessionbroker

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
)

func (b *Broker) setupSocket() error {
	// Remove stale socket file
	os.Remove(b.socketPath)

	// Ensure directory exists
	dir := filepath.Dir(b.socketPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	if err := os.Chmod(dir, 0755); err != nil {
		return fmt.Errorf("chmod %s: %w", dir, err)
	}

	listener, err := net.Listen("unix", b.socketPath)
	if err != nil {
		return fmt.Errorf("listen %s: %w", b.socketPath, err)
	}

	// Allow normal user helpers to traverse the directory and connect to the
	// socket. Peer credential verification and binary checks remain the gate.
	if err := os.Chmod(b.socketPath, 0660); err != nil {
		listener.Close()
		return fmt.Errorf("chmod %s: %w", b.socketPath, err)
	}

	b.listener = listener
	return nil
}

// peerWinSessionID is a no-op on non-Windows platforms.
func peerWinSessionID(pid int) uint32 {
	return 0
}
