package desktop

// MonitorInfo describes a connected display output.
type MonitorInfo struct {
	Index     int    `json:"index"`
	Name      string `json:"name"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	X         int    `json:"x"`
	Y         int    `json:"y"`
	IsPrimary bool   `json:"isPrimary"`
}

// GetScreenResolution returns the width and height for the given monitor index.
// Returns (0, 0) if the monitor can't be enumerated.
func GetScreenResolution(displayIndex int) (int, int) {
	monitors, err := ListMonitors()
	if err != nil || len(monitors) == 0 {
		return 0, 0
	}
	for _, m := range monitors {
		if m.Index == displayIndex {
			return m.Width, m.Height
		}
	}
	// Fall back to primary
	return monitors[0].Width, monitors[0].Height
}
