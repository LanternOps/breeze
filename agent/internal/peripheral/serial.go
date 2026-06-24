package peripheral

import "strings"

// parseSerial extracts the serial/instance segment (the last backslash-delimited
// field) from a Windows USB/USBSTOR device instance ID. Returns "" if the ID has
// fewer than three segments (no per-instance field).
func parseSerial(deviceID string) string {
	parts := strings.Split(deviceID, `\`)
	if len(parts) < 3 {
		return ""
	}
	return parts[len(parts)-1]
}
