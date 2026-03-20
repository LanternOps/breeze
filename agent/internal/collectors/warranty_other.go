//go:build !darwin

package collectors

// AppleWarrantyInfo contains warranty data extracted from local macOS plists.
// On non-darwin platforms, this is a no-op.
type AppleWarrantyInfo struct {
	CoverageEndDate   string         `json:"coverageEndDate,omitempty"`
	CoverageStartDate string         `json:"coverageStartDate,omitempty"`
	DeviceName        string         `json:"deviceName,omitempty"`
	CoverageType      string         `json:"coverageType,omitempty"`
	Raw               map[string]any `json:"raw,omitempty"`
}

// CollectAppleWarranty is a no-op on non-darwin platforms.
func CollectAppleWarranty() (*AppleWarrantyInfo, error) {
	return nil, nil
}
