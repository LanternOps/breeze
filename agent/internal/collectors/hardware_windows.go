//go:build windows

package collectors

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const wmicTimeout = 15 * time.Second

// wmicGet runs a wmic query and returns the trimmed output value.
func wmicGet(args []string, property string) string {
	ctx, cancel := context.WithTimeout(context.Background(), wmicTimeout)
	defer cancel()

	cmdArgs := append(args, "get", property, "/format:list")
	out, err := exec.CommandContext(ctx, "wmic", cmdArgs...).Output()
	if err != nil {
		fmt.Printf("Warning: wmic %s failed: %v\n", strings.Join(args, " "), err)
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
	hw.SerialNumber = wmicGet([]string{"bios"}, "SerialNumber")
	hw.Manufacturer = wmicGet([]string{"computersystem"}, "Manufacturer")
	hw.Model = wmicGet([]string{"computersystem"}, "Model")
	hw.BIOSVersion = wmicGet([]string{"bios"}, "SMBIOSBIOSVersion")
	hw.GPUModel = wmicGet([]string{"path", "win32_videocontroller"}, "Name")
}
