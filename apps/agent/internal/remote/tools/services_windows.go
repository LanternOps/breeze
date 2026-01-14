//go:build windows

package tools

import (
	"fmt"
	"strings"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// ListServices returns all Windows services with their details.
func (sm *ServiceManager) ListServices() ([]WindowsService, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	manager, err := mgr.Connect()
	if err != nil {
		return nil, fmt.Errorf("failed to connect to Service Control Manager: %w (ensure running as Administrator)", err)
	}
	defer manager.Disconnect()

	serviceNames, err := manager.ListServices()
	if err != nil {
		return nil, fmt.Errorf("failed to list services: %w", err)
	}

	services := make([]WindowsService, 0, len(serviceNames))
	for _, name := range serviceNames {
		svc, err := sm.getServiceDetails(manager, name)
		if err != nil {
			// Skip services we cannot access, continue with others
			continue
		}
		services = append(services, *svc)
	}

	return services, nil
}

// GetService returns details for a specific Windows service.
func (sm *ServiceManager) GetService(name string) (*WindowsService, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	manager, err := mgr.Connect()
	if err != nil {
		return nil, fmt.Errorf("failed to connect to Service Control Manager: %w (ensure running as Administrator)", err)
	}
	defer manager.Disconnect()

	return sm.getServiceDetails(manager, name)
}

// StartService starts a Windows service.
func (sm *ServiceManager) StartService(name string) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("failed to connect to Service Control Manager: %w (ensure running as Administrator)", err)
	}
	defer manager.Disconnect()

	service, err := manager.OpenService(name)
	if err != nil {
		return fmt.Errorf("failed to open service %q: %w", name, err)
	}
	defer service.Close()

	err = service.Start()
	if err != nil {
		return fmt.Errorf("failed to start service %q: %w", name, err)
	}

	// Wait for service to start (with timeout)
	return sm.waitForStatus(service, svc.Running, 30*time.Second)
}

// StopService stops a Windows service.
func (sm *ServiceManager) StopService(name string) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("failed to connect to Service Control Manager: %w (ensure running as Administrator)", err)
	}
	defer manager.Disconnect()

	service, err := manager.OpenService(name)
	if err != nil {
		return fmt.Errorf("failed to open service %q: %w", name, err)
	}
	defer service.Close()

	status, err := service.Control(svc.Stop)
	if err != nil {
		return fmt.Errorf("failed to stop service %q: %w", name, err)
	}

	if status.State == svc.Stopped {
		return nil
	}

	// Wait for service to stop (with timeout)
	return sm.waitForStatus(service, svc.Stopped, 30*time.Second)
}

// RestartService stops and then starts a Windows service.
func (sm *ServiceManager) RestartService(name string) error {
	// Note: We don't hold the lock across both operations to allow
	// other operations to proceed. Each operation acquires its own lock.
	err := sm.StopService(name)
	if err != nil {
		return fmt.Errorf("failed to stop service during restart: %w", err)
	}

	err = sm.StartService(name)
	if err != nil {
		return fmt.Errorf("failed to start service during restart: %w", err)
	}

	return nil
}

// SetStartupType changes the startup type of a Windows service.
// Valid startup types: "automatic", "manual", "disabled", "delayed-start"
func (sm *ServiceManager) SetStartupType(name string, startupType string) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("failed to connect to Service Control Manager: %w (ensure running as Administrator)", err)
	}
	defer manager.Disconnect()

	service, err := manager.OpenService(name)
	if err != nil {
		return fmt.Errorf("failed to open service %q: %w", name, err)
	}
	defer service.Close()

	config, err := service.Config()
	if err != nil {
		return fmt.Errorf("failed to get service config for %q: %w", name, err)
	}

	var newStartType uint32
	var delayedStart bool

	switch strings.ToLower(startupType) {
	case StartupTypeAutomatic:
		newStartType = mgr.StartAutomatic
		delayedStart = false
	case StartupTypeDelayedStart:
		newStartType = mgr.StartAutomatic
		delayedStart = true
	case StartupTypeManual:
		newStartType = mgr.StartManual
		delayedStart = false
	case StartupTypeDisabled:
		newStartType = mgr.StartDisabled
		delayedStart = false
	default:
		return fmt.Errorf("invalid startup type %q: must be one of: automatic, manual, disabled, delayed-start", startupType)
	}

	config.StartType = newStartType
	config.DelayedAutoStart = delayedStart

	err = service.UpdateConfig(config)
	if err != nil {
		return fmt.Errorf("failed to update service config for %q: %w", name, err)
	}

	return nil
}

// getServiceDetails retrieves full details for a service.
func (sm *ServiceManager) getServiceDetails(manager *mgr.Mgr, name string) (*WindowsService, error) {
	service, err := manager.OpenService(name)
	if err != nil {
		return nil, fmt.Errorf("failed to open service %q: %w", name, err)
	}
	defer service.Close()

	config, err := service.Config()
	if err != nil {
		return nil, fmt.Errorf("failed to get config for service %q: %w", name, err)
	}

	status, err := service.Query()
	if err != nil {
		return nil, fmt.Errorf("failed to query status for service %q: %w", name, err)
	}

	return &WindowsService{
		Name:         name,
		DisplayName:  config.DisplayName,
		Description:  config.Description,
		Status:       stateToStatus(status.State),
		StartupType:  startTypeToString(config.StartType, config.DelayedAutoStart),
		Account:      config.ServiceStartName,
		Path:         config.BinaryPathName,
		Dependencies: config.Dependencies,
	}, nil
}

// waitForStatus waits for a service to reach the desired state.
func (sm *ServiceManager) waitForStatus(service *mgr.Service, desiredState svc.State, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		status, err := service.Query()
		if err != nil {
			return fmt.Errorf("failed to query service status: %w", err)
		}

		if status.State == desiredState {
			return nil
		}

		time.Sleep(500 * time.Millisecond)
	}

	return fmt.Errorf("timeout waiting for service to reach desired state")
}

// stateToStatus converts Windows service state to a status string.
func stateToStatus(state svc.State) string {
	switch state {
	case svc.Running:
		return ServiceStatusRunning
	case svc.Stopped:
		return ServiceStatusStopped
	case svc.Paused:
		return ServiceStatusPaused
	case svc.StartPending:
		return ServiceStatusStarting
	case svc.StopPending:
		return ServiceStatusStopping
	case svc.PausePending:
		return ServiceStatusPaused
	case svc.ContinuePending:
		return ServiceStatusStarting
	default:
		return ServiceStatusUnknown
	}
}

// startTypeToString converts Windows service start type to a string.
func startTypeToString(startType uint32, delayedStart bool) string {
	switch startType {
	case mgr.StartAutomatic:
		if delayedStart {
			return StartupTypeDelayedStart
		}
		return StartupTypeAutomatic
	case mgr.StartManual:
		return StartupTypeManual
	case mgr.StartDisabled:
		return StartupTypeDisabled
	default:
		return "unknown"
	}
}
