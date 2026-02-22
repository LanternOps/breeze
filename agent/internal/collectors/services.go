package collectors

// ServiceInfo represents a system service.
type ServiceInfo struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName,omitempty"`
	State       string `json:"state"`             // running, stopped, failed, etc.
	StartupType string `json:"startupType"`       // automatic, manual, disabled, unknown
	Account     string `json:"account,omitempty"` // Service account (Windows)
}

// ServiceCollector collects service information.
type ServiceCollector struct{}

// NewServiceCollector creates a new service collector.
func NewServiceCollector() *ServiceCollector {
	return &ServiceCollector{}
}

// Collect returns list of services (platform-specific implementation).
func (c *ServiceCollector) Collect() ([]ServiceInfo, error) {
	return collectServices()
}
