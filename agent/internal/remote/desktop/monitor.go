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
