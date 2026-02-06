package collectors

import (
	"os/exec"
	"strings"
)

// wmicGet runs a wmic query and returns the trimmed output value.
func wmicGet(class, property string) string {
	out, err := exec.Command("wmic", class, "get", property, "/format:list").Output()
	if err != nil {
		return ""
	}
	// Output format: "Property=Value\r\n"
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, property+"=") {
			return strings.TrimSpace(strings.TrimPrefix(line, property+"="))
		}
	}
	return ""
}

func collectPlatformHardware(hw *HardwareInfo) {
	hw.SerialNumber = wmicGet("bios", "SerialNumber")
	hw.Manufacturer = wmicGet("computersystem", "Manufacturer")
	hw.Model = wmicGet("computersystem", "Model")
	hw.BIOSVersion = wmicGet("bios", "SMBIOSBIOSVersion")
	hw.GPUModel = wmicGet("path win32_videocontroller", "Name")
}
