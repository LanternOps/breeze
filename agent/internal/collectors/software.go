package collectors

// SoftwareItem represents an installed application/package on the system
type SoftwareItem struct {
	Name            string `json:"name"`
	Version         string `json:"version,omitempty"`
	Vendor          string `json:"vendor,omitempty"`
	InstallDate     string `json:"installDate,omitempty"`
	InstallLocation string `json:"installLocation,omitempty"`
	UninstallString string `json:"uninstallString,omitempty"`
}

// SoftwareCollector collects installed software information
type SoftwareCollector struct{}

// NewSoftwareCollector creates a new software collector
func NewSoftwareCollector() *SoftwareCollector {
	return &SoftwareCollector{}
}

// Collect returns a list of installed software on the system
// The implementation is platform-specific (see software_*.go files)
