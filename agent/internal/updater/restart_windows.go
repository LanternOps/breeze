//go:build windows

package updater

import (
	"fmt"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const serviceName = "BreezeAgent"

// Restart restarts the Windows service
func Restart() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("failed to connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("failed to open service: %w", err)
	}
	defer s.Close()

	// Stop the service
	status, err := s.Control(svc.Stop)
	if err != nil {
		return fmt.Errorf("failed to stop service: %w", err)
	}

	// Wait for service to stop
	timeout := time.Now().Add(30 * time.Second)
	for status.State != svc.Stopped {
		if time.Now().After(timeout) {
			return fmt.Errorf("timeout waiting for service to stop")
		}
		time.Sleep(300 * time.Millisecond)
		status, err = s.Query()
		if err != nil {
			return fmt.Errorf("failed to query service: %w", err)
		}
	}

	// Start the service
	if err := s.Start(); err != nil {
		return fmt.Errorf("failed to start service: %w", err)
	}

	// Wait for service to start
	timeout = time.Now().Add(30 * time.Second)
	for {
		status, err = s.Query()
		if err != nil {
			return fmt.Errorf("failed to query service: %w", err)
		}
		if status.State == svc.Running {
			break
		}
		if time.Now().After(timeout) {
			return fmt.Errorf("timeout waiting for service to start")
		}
		time.Sleep(300 * time.Millisecond)
	}

	return nil
}
