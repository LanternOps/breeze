package collectors

import (
	"os"
	"os/exec"
	"strings"
)

// readDMI reads a value from /sys/class/dmi/id/
func readDMI(name string) string {
	data, err := os.ReadFile("/sys/class/dmi/id/" + name)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func collectPlatformHardware(hw *HardwareInfo) {
	// DMI data (works on physical machines and most VMs)
	hw.SerialNumber = readDMI("product_serial")
	hw.Manufacturer = readDMI("sys_vendor")
	hw.Model = readDMI("product_name")
	hw.BIOSVersion = readDMI("bios_version")

	// GPU via lspci
	out, err := exec.Command("lspci").Output()
	if err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			lower := strings.ToLower(line)
			if strings.Contains(lower, "vga") || strings.Contains(lower, "3d controller") {
				// Format: "00:02.0 VGA compatible controller: Intel Corporation ..."
				parts := strings.SplitN(line, ": ", 2)
				if len(parts) == 2 {
					hw.GPUModel = strings.TrimSpace(parts[1])
					break
				}
			}
		}
	}
}
