//go:build !windows && !darwin

package svcquery

import "fmt"

// IsRunning checks if a service is running on Linux via systemctl.
func IsRunning(name string) (bool, error) {
	return false, fmt.Errorf("svcquery: not implemented on this platform")
}

// GetStatus returns service status on Linux.
func GetStatus(name string) (ServiceInfo, error) {
	return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: not implemented on this platform")
}

// ListServices returns all services on Linux.
func ListServices() ([]ServiceInfo, error) {
	return nil, fmt.Errorf("svcquery: not implemented on this platform")
}
