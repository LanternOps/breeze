//go:build windows

package tools

import (
	"fmt"
	"strings"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func listServicesOS(search, statusFilter string) ([]ServiceInfo, error) {
	m, err := mgr.Connect()
	if err != nil {
		return nil, fmt.Errorf("failed to connect to service manager: %w", err)
	}
	defer m.Disconnect()

	names, err := m.ListServices()
	if err != nil {
		return nil, fmt.Errorf("failed to list services: %w", err)
	}

	var services []ServiceInfo
	searchLower := strings.ToLower(search)

	for _, name := range names {
		s, err := m.OpenService(name)
		if err != nil {
			continue
		}

		config, err := s.Config()
		if err != nil {
			s.Close()
			continue
		}

		status, err := s.Query()
		if err != nil {
			s.Close()
			continue
		}

		info := ServiceInfo{
			Name:        name,
			DisplayName: config.DisplayName,
			Status:      stateToString(status.State),
			StartupType: startTypeToString(config.StartType),
			Account:     config.ServiceStartName,
			Path:        config.BinaryPathName,
			Description: config.Description,
		}

		s.Close()

		// Apply search filter
		if search != "" {
			if !strings.Contains(strings.ToLower(info.Name), searchLower) &&
				!strings.Contains(strings.ToLower(info.DisplayName), searchLower) {
				continue
			}
		}

		// Apply status filter
		if statusFilter != "" {
			if !strings.EqualFold(info.Status, statusFilter) {
				continue
			}
		}

		services = append(services, info)
	}

	return services, nil
}

func getServiceOS(name string) (*ServiceInfo, error) {
	m, err := mgr.Connect()
	if err != nil {
		return nil, fmt.Errorf("failed to connect to service manager: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(name)
	if err != nil {
		return nil, fmt.Errorf("service not found: %w", err)
	}
	defer s.Close()

	config, err := s.Config()
	if err != nil {
		return nil, fmt.Errorf("failed to get service config: %w", err)
	}

	status, err := s.Query()
	if err != nil {
		return nil, fmt.Errorf("failed to query service: %w", err)
	}

	return &ServiceInfo{
		Name:        name,
		DisplayName: config.DisplayName,
		Status:      stateToString(status.State),
		StartupType: startTypeToString(config.StartType),
		Account:     config.ServiceStartName,
		Path:        config.BinaryPathName,
		Description: config.Description,
	}, nil
}

func startServiceOS(name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("failed to connect to service manager: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(name)
	if err != nil {
		return fmt.Errorf("service not found: %w", err)
	}
	defer s.Close()

	err = s.Start()
	if err != nil {
		return fmt.Errorf("failed to start service: %w", err)
	}

	return waitForServiceState(s, svc.Running, 30*time.Second)
}

func stopServiceOS(name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("failed to connect to service manager: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(name)
	if err != nil {
		return fmt.Errorf("service not found: %w", err)
	}
	defer s.Close()

	status, err := s.Control(svc.Stop)
	if err != nil {
		return fmt.Errorf("failed to stop service: %w", err)
	}

	if status.State != svc.Stopped {
		return waitForServiceState(s, svc.Stopped, 30*time.Second)
	}

	return nil
}

func restartServiceOS(name string) error {
	if err := stopServiceOS(name); err != nil {
		// Service might not be running, continue with start
		if !strings.Contains(err.Error(), "not started") {
			return err
		}
	}
	return startServiceOS(name)
}

func waitForServiceState(s *mgr.Service, desiredState svc.State, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		status, err := s.Query()
		if err != nil {
			return err
		}
		if status.State == desiredState {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for service state")
}

func stateToString(state svc.State) string {
	switch state {
	case svc.Stopped:
		return "Stopped"
	case svc.StartPending:
		return "StartPending"
	case svc.StopPending:
		return "StopPending"
	case svc.Running:
		return "Running"
	case svc.ContinuePending:
		return "ContinuePending"
	case svc.PausePending:
		return "PausePending"
	case svc.Paused:
		return "Paused"
	default:
		return "Unknown"
	}
}

func startTypeToString(startType uint32) string {
	switch startType {
	case mgr.StartAutomatic:
		return "Automatic"
	case mgr.StartManual:
		return "Manual"
	case mgr.StartDisabled:
		return "Disabled"
	default:
		return "Unknown"
	}
}
