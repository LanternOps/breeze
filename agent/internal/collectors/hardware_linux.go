//go:build linux

package collectors

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

var dmiWarningOnce sync.Once

// readDMI reads a value from /sys/class/dmi/id/.
// Logs a warning once if DMI files are inaccessible (e.g. no root, containers).
func readDMI(name string) string {
	data, err := os.ReadFile("/sys/class/dmi/id/" + name)
	if err != nil {
		dmiWarningOnce.Do(func() {
			fmt.Printf("Warning: cannot read DMI data (/sys/class/dmi/id/%s): %v\n", name, err)
		})
		return ""
	}
	return strings.TrimSpace(string(data))
}

func collectPlatformHardware(hw *HardwareInfo) {
	hw.SerialNumber = readDMI("product_serial")
	hw.Manufacturer = readDMI("sys_vendor")
	hw.Model = readDMI("product_name")
	hw.BIOSVersion = readDMI("bios_version")

	// GPU via lspci (with timeout)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "lspci").Output()
	if err != nil {
		fmt.Printf("Warning: lspci failed (GPU detection skipped): %v\n", err)
	} else {
		for _, line := range strings.Split(string(out), "\n") {
			lower := strings.ToLower(line)
			if strings.Contains(lower, "vga") || strings.Contains(lower, "3d controller") {
				parts := strings.SplitN(line, ": ", 2)
				if len(parts) == 2 {
					hw.GPUModel = strings.TrimSpace(parts[1])
					break
				}
			}
		}
	}
}
