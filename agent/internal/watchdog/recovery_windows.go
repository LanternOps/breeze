//go:build windows

package watchdog

import (
	"fmt"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const agentWindowsServiceName = "BreezeAgent"

// restartAgentService stops then starts the Windows service for the agent.
// It waits up to 15 seconds for the service to reach the Stopped state before
// issuing the start request.
func restartAgentService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("failed to connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(agentWindowsServiceName)
	if err != nil {
		return fmt.Errorf("failed to open service %q: %w", agentWindowsServiceName, err)
	}
	defer s.Close()

	// Stop the service (ignore error — it may already be stopped).
	_, _ = s.Control(svc.Stop)

	// Wait up to 15 s for the service to reach Stopped.
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		st, qErr := s.Query()
		if qErr != nil {
			return fmt.Errorf("failed to query service state: %w", qErr)
		}
		if st.State == svc.Stopped {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	if err := s.Start(); err != nil {
		return fmt.Errorf("failed to start service %q: %w", agentWindowsServiceName, err)
	}
	return nil
}

// startAgentService starts the Windows service for the agent.
func startAgentService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("failed to connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(agentWindowsServiceName)
	if err != nil {
		return fmt.Errorf("failed to open service %q: %w", agentWindowsServiceName, err)
	}
	defer s.Close()

	if err := s.Start(); err != nil {
		return fmt.Errorf("failed to start service %q: %w", agentWindowsServiceName, err)
	}
	return nil
}
