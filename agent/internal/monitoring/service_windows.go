//go:build windows

package monitoring

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/svcquery"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func checkService(name string) CheckResult {
	info, err := svcquery.GetStatus(name)
	if err != nil {
		return CheckResult{
			Status:  StatusNotFound,
			Details: map[string]any{"error": err.Error()},
		}
	}

	status := CheckStatus(StatusStopped)
	if info.IsActive() {
		status = StatusRunning
	}

	return CheckResult{
		Status: status,
		Details: map[string]any{
			"displayName": info.DisplayName,
			"startType":   info.StartType,
			"binaryPath":  info.BinaryPath,
		},
	}
}

func restartService(name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(name)
	if err != nil {
		return fmt.Errorf("open service %s: %w", name, err)
	}
	defer s.Close()

	// Stop the service (ignore error if already stopped)
	status, err := s.Control(svc.Stop)
	if err != nil {
		// Already stopped is fine
		log.Debug("service stop control returned error (may already be stopped)", "name", name, "error", err.Error())
	} else {
		// Wait for stop to complete (up to 15s)
		for i := 0; i < 30 && status.State != svc.Stopped; i++ {
			time.Sleep(500 * time.Millisecond)
			status, err = s.Query()
			if err != nil {
				break
			}
		}
	}

	// Start the service
	if err := s.Start(); err != nil {
		return fmt.Errorf("failed to start service %s: %w", name, err)
	}
	return nil
}
