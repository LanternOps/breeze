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
	if err := os.MkdirAll(dir, 0770); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}

	listener, err := net.Listen("unix", b.socketPath)
	if err != nil {
		return fmt.Errorf("listen %s: %w", b.socketPath, err)
	}

	// Set socket permissions: 0770 (owner + group can read/write)
	if err := os.Chmod(b.socketPath, 0770); err != nil {
		listener.Close()
		return fmt.Errorf("chmod %s: %w", b.socketPath, err)
	}

	b.listener = listener
	return nil
}
