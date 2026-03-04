//go:build darwin

package collectors

// getChassisType returns empty on macOS (no DMI, all workstations).
func getChassisType() string {
	return ""
}
