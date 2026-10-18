package collectors

// ServiceInfo represents a system service.
type ServiceInfo struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName,omitempty"`
	State       string `json:"state"`             // running, stopped, failed, etc.
	StartupType string `json:"startupType"`       // automatic, manual, disabled, unknown
	Account     string `json:"account,omitempty"` // Service account (Windows)

	// accountUnreliable and startupTypeUnreliable mark a field whose raw read
	// contained control characters (#8904). Stripping them leaves a value that
	// is still wrong (four NULs + "lSystem" becomes "lSystem"), so the change
	// tracker keeps the previous snapshot's value instead of recording a false
	// change. Unexported, so never serialised or sent to the API.
	accountUnreliable     bool
	startupTypeUnreliable bool
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
