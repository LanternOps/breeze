package svcquery

// ServiceStatus constants.
const (
	StatusRunning  = "running"
	StatusStopped  = "stopped"
	StatusDisabled = "disabled"
	StatusUnknown  = "unknown"
)

// ServiceInfo describes a system service.
type ServiceInfo struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName,omitempty"`
	Status      string `json:"status"`
	StartType   string `json:"startType,omitempty"`
	BinaryPath  string `json:"binaryPath,omitempty"`
}

// IsActive returns true if the service is currently running.
func (s ServiceInfo) IsActive() bool {
	return s.Status == StatusRunning
}
