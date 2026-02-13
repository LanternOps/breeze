package svcquery

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
