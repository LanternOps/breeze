//go:build linux

package collectors

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

var dmiWarningOnce sync.Once

// dmiRoot is a var so tests can point it at a temp directory.
var dmiRoot = "/sys/class/dmi/id/"

// readDMI reads a value from dmiRoot.
// Logs a warning once if DMI files are inaccessible (e.g. no root, containers).
func readDMI(name string) string {
	path := dmiRoot + name
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

// collectLinuxProductSKU reads the system SKU. The attribute is missing on older
// kernels and that is routine, so it must not spend readDMI's one-shot warning,
// which exists to report that DMI as a whole is unreadable.
func collectLinuxProductSKU() string {
	if _, err := os.Stat(dmiRoot + "product_sku"); errors.Is(err, fs.ErrNotExist) {
		return ""
	}
	return cleanProductSKU(readDMI("product_sku"))
}

func collectPlatformHardware(hw *HardwareInfo) {
	hw.SerialNumber = readDMI("product_serial")
	hw.ProductSKU = collectLinuxProductSKU()
	hw.Manufacturer = readDMI("sys_vendor")
	hw.Model = readDMI("product_name")
	hw.MotherboardManufacturer = cleanHardwareIdentityValue(readDMI("board_vendor"))
	hw.MotherboardProduct = cleanHardwareIdentityValue(readDMI("board_name"))
	hw.MotherboardVersion = cleanHardwareIdentityValue(readDMI("board_version"))
	hw.BIOSVersion = readDMI("bios_version")

	hw.GPUModel = collectLinuxGPUModel()
}

// lspciAvailable caches whether lspci is installed so minimal hosts do not
// attempt (and warn about) a spawn on every collection.
var lspciAvailable = newCachedHostProbe(hostProbeAvailabilityTTL, func() bool {
	if _, err := exec.LookPath("lspci"); err != nil {
		slog.Debug("lspci not installed; reading GPU model from /sys/bus/pci instead")
		return false
	}
	return true
})

func collectLinuxGPUModel() string {
	if !lspciAvailable.get() {
		return gpuModelFromPCISysfs("/sys/bus/pci/devices")
	}
	out, err := runCollectorOutput(collectorLongCommandTimeout, "lspci")
	if err != nil {
		slog.Warn("lspci failed", "error", err.Error())
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		lower := strings.ToLower(line)
		if strings.Contains(lower, "vga") || strings.Contains(lower, "3d controller") {
			parts := strings.SplitN(line, ": ", 2)
			if len(parts) == 2 {
				return truncateCollectorString(strings.TrimSpace(parts[1]))
			}
		}
	}
	return ""
}

var pciVendorNames = map[string]string{"10de": "NVIDIA", "1002": "AMD", "8086": "Intel"}

// gpuModelFromPCISysfs finds the first VGA (0x0300) or 3D (0x0302) PCI device.
// Without pci.ids only vendor and device IDs are known, so the name is coarse.
func gpuModelFromPCISysfs(root string) string {
	dirs, _ := filepath.Glob(filepath.Join(root, "*"))
	for _, dir := range dirs {
		var class uint32
		if _, err := fmt.Sscanf(readPCIAttr(dir, "class"), "0x%x", &class); err != nil {
			continue
		}
		if base := class >> 8; base != 0x0300 && base != 0x0302 {
			continue
		}
		vendor := strings.TrimPrefix(readPCIAttr(dir, "vendor"), "0x")
		device := strings.TrimPrefix(readPCIAttr(dir, "device"), "0x")
		if vendor == "" || device == "" {
			continue
		}
		if name, ok := pciVendorNames[vendor]; ok {
			return truncateCollectorString(name + " Device " + device)
		}
		return truncateCollectorString("Device " + vendor + ":" + device)
	}
	return ""
}

func readPCIAttr(dir, name string) string {
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(string(data)))
}
