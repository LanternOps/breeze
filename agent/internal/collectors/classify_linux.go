//go:build linux

package collectors

import (
	"os"
	"strings"
)

// getChassisType reads SMBIOS chassis type from sysfs on Linux.
func getChassisType() string {
	data, err := os.ReadFile("/sys/class/dmi/id/chassis_type")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}
