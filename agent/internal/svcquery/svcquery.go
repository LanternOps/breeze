package svcquery

import "errors"

// ErrServiceNotFound is wrapped by GetStatus when the named service does not
// exist (by key name or display name). Any other GetStatus error means the
// service could not be inspected (e.g. access denied), not that it is absent;
// callers must not report those as "not found" (#7967).
var ErrServiceNotFound = errors.New("service not found")

// ServiceStatus represents the status of a system service.
type ServiceStatus string

// ServiceStatus constants.
const (
	StatusRunning  ServiceStatus = "running"
	StatusStopped  ServiceStatus = "stopped"
	StatusDisabled ServiceStatus = "disabled"
	StatusUnknown  ServiceStatus = "unknown"
)

// ServiceInfo describes a system service.
type ServiceInfo struct {
	Name        string        `json:"name"`
	DisplayName string        `json:"displayName,omitempty"`
	Status      ServiceStatus `json:"status"`
	StartType   string        `json:"startType,omitempty"`
	BinaryPath  string        `json:"binaryPath,omitempty"`
}

// IsActive returns true if the service is currently running.
func (s ServiceInfo) IsActive() bool {
	return s.Status == StatusRunning
}
