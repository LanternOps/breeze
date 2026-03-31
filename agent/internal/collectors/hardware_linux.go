//go:build linux

package collectors

import (
	"log/slog"
	"os"
	"strings"
	"sync"
)

var dmiWarningOnce sync.Once

// readDMI reads a value from /sys/class/dmi/id/.
// Logs a warning once if DMI files are inaccessible (e.g. no root, containers).
func readDMI(name string) string {
	path := "/sys/class/dmi/id/" + name
	if statInfo, err := os.Stat(path); err == nil && statInfo.Size() > collectorFileReadLimit {
		dmiWarningOnce.Do(func() {
			slog.Warn("cannot read oversized DMI data", "path", path)
		})
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		dmiWarningOnce.Do(func() {
			slog.Warn("cannot read DMI data", "path", path, "error", err.Error())
		})
		return ""
	}
	return truncateCollectorString(strings.TrimSpace(string(data)))
}

func collectPlatformHardware(hw *HardwareInfo) {
	hw.SerialNumber = readDMI("product_serial")
	hw.Manufacturer = readDMI("sys_vendor")
	hw.Model = readDMI("product_name")
	hw.BIOSVersion = readDMI("bios_version")

	// GPU via lspci (with timeout)
	out, err := runCollectorOutput(collectorLongCommandTimeout, "lspci")
	if err != nil {
		slog.Warn("lspci failed", "error", err.Error())
	} else {
		for _, line := range strings.Split(string(out), "\n") {
			lower := strings.ToLower(line)
			if strings.Contains(lower, "vga") || strings.Contains(lower, "3d controller") {
				parts := strings.SplitN(line, ": ", 2)
				if len(parts) == 2 {
					hw.GPUModel = truncateCollectorString(strings.TrimSpace(parts[1]))
					break
				}
			}
		}
	}
}
