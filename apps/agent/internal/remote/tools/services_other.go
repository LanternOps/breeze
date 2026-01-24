//go:build !windows

package tools

// ListServices returns an error on non-Windows platforms.
func (sm *ServiceManager) ListServices() ([]WindowsService, error) {
	return nil, newPlatformError("ListServices")
}

// GetService returns an error on non-Windows platforms.
func (sm *ServiceManager) GetService(name string) (*WindowsService, error) {
	return nil, newPlatformError("GetService")
}

// StartService returns an error on non-Windows platforms.
func (sm *ServiceManager) StartService(name string) error {
	return newPlatformError("StartService")
}

// StopService returns an error on non-Windows platforms.
func (sm *ServiceManager) StopService(name string) error {
	return newPlatformError("StopService")
}

// RestartService returns an error on non-Windows platforms.
func (sm *ServiceManager) RestartService(name string) error {
	return newPlatformError("RestartService")
}

// SetStartupType returns an error on non-Windows platforms.
func (sm *ServiceManager) SetStartupType(name string, startupType string) error {
	return newPlatformError("SetStartupType")
}
