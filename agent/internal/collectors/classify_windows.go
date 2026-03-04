//go:build windows

package collectors

import (
	"os/exec"
	"strings"
)

// getChassisType reads chassis type via WMIC on Windows.
func getChassisType() string {
	out, err := exec.Command("wmic", "systemenclosure", "get", "ChassisTypes", "/format:list").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ChassisTypes=") {
			val := strings.TrimPrefix(line, "ChassisTypes=")
			val = strings.Trim(val, "{}")
			// Take the first value if multiple
			parts := strings.Split(val, ",")
			if len(parts) > 0 {
				return strings.TrimSpace(parts[0])
			}
		}
	}
	return ""
}
