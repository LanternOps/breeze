//go:build !windows

package desktop

// ListMonitors is a stub for non-Windows platforms.
// Multi-monitor enumeration currently only supports DXGI on Windows.
func ListMonitors() ([]MonitorInfo, error) {
	return []MonitorInfo{{
		Index:     0,
		Name:      "Default",
		Width:     1920,
		Height:    1080,
		IsPrimary: true,
	}}, nil
}
