//go:build windows

package svcquery

import (
	"fmt"
	"strings"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// IsRunning returns true if the named Windows service exists and is running.
func IsRunning(name string) (bool, error) {
	info, err := GetStatus(name)
	if err != nil {
		return false, err
	}
	return info.IsActive(), nil
}

// GetStatus queries a single Windows service by name.
func GetStatus(name string) (ServiceInfo, error) {
	m, err := mgr.Connect()
	if err != nil {
		return ServiceInfo{}, fmt.Errorf("svcquery: connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(name)
	if err != nil {
		return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: open service %s: %w", name, err)
	}
	defer s.Close()

	status, err := s.Query()
	if err != nil {
		return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: query %s: %w", name, err)
	}

	cfg, _ := s.Config()

	info := ServiceInfo{
		Name:        name,
		DisplayName: cfg.DisplayName,
		Status:      mapWindowsState(status.State),
		StartType:   mapWindowsStartType(cfg.StartType),
		BinaryPath:  cfg.BinaryPathName,
	}
	return info, nil
}

// ListServices returns all services on the system.
func ListServices() ([]ServiceInfo, error) {
	m, err := mgr.Connect()
	if err != nil {
		return nil, fmt.Errorf("svcquery: connect to SCM: %w", err)
	}
	defer m.Disconnect()

	names, err := m.ListServices()
	if err != nil {
		return nil, fmt.Errorf("svcquery: list services: %w", err)
	}

	services := make([]ServiceInfo, 0, len(names))
	for _, name := range names {
		s, err := m.OpenService(name)
		if err != nil {
			continue
		}
		status, err := s.Query()
		if err != nil {
			s.Close()
			continue
		}
		cfg, _ := s.Config()
		services = append(services, ServiceInfo{
			Name:        name,
			DisplayName: cfg.DisplayName,
			Status:      mapWindowsState(status.State),
			StartType:   mapWindowsStartType(cfg.StartType),
			BinaryPath:  cfg.BinaryPathName,
		})
		s.Close()
	}
	return services, nil
}

func mapWindowsState(state svc.State) ServiceStatus {
	switch state {
	case svc.Running:
		return StatusRunning
	case svc.Stopped:
		return StatusStopped
	case svc.Paused:
		return StatusStopped
	case svc.StartPending, svc.ContinuePending:
		return StatusRunning
	case svc.StopPending, svc.PausePending:
		return StatusStopped
	default:
		return StatusUnknown
	}
}

func mapWindowsStartType(startType uint32) string {
	switch startType {
	case mgr.StartAutomatic, mgr.StartAutomatic + 0x80: // 0x80 = delayed start flag
		return "automatic"
	case mgr.StartManual:
		return "manual"
	case mgr.StartDisabled:
		return "disabled"
	default:
		return strings.ToLower(fmt.Sprintf("type_%d", startType))
	}
}
