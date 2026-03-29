//go:build linux

package systemstate

import (
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// CollectHardwareProfile captures hardware info from /proc, /sys, and lsblk.
func (c *LinuxCollector) CollectHardwareProfile() (*HardwareProfile, error) {
	hw := &HardwareProfile{}

	// CPU from /proc/cpuinfo
	if data, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		hw.CPUModel, hw.CPUCores = parseProcCPUInfo(string(data))
	}

	// Memory from /proc/meminfo
	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		hw.TotalMemoryMB = parseProcMemInfo(string(data))
	}

	// Disks from lsblk -J
	if out, err := exec.Command("lsblk", "-J", "-b", "-o", "NAME,SIZE,MODEL,TYPE,MOUNTPOINT,FSTYPE,LABEL").Output(); err == nil {
		hw.Disks = parseLsblkJSON(out)
	}

	// NICs from /sys/class/net/
	hw.NetworkAdapters = readSysNetNICs()

	// UEFI detection: /sys/firmware/efi exists only on UEFI boots.
	if _, err := os.Stat("/sys/firmware/efi"); err == nil {
		hw.IsUEFI = true
	}

	// BIOS version
	if data, err := os.ReadFile("/sys/class/dmi/id/bios_version"); err == nil {
		hw.BIOSVersion = strings.TrimSpace(string(data))
	}

	// Motherboard
	mfr, _ := os.ReadFile("/sys/class/dmi/id/board_vendor")
	prod, _ := os.ReadFile("/sys/class/dmi/id/board_name")
	if len(mfr) > 0 || len(prod) > 0 {
		hw.Motherboard = strings.TrimSpace(string(mfr)) + " " + strings.TrimSpace(string(prod))
	}

	return hw, nil
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

// parseProcCPUInfo extracts model name and core count from /proc/cpuinfo.
func parseProcCPUInfo(data string) (model string, cores int) {
	for _, line := range strings.Split(data, "\n") {
		if strings.HasPrefix(line, "model name") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 && model == "" {
				model = strings.TrimSpace(parts[1])
			}
			cores++
		}
	}
	return model, cores
}

// parseProcMemInfo extracts total memory in MB from /proc/meminfo.
func parseProcMemInfo(data string) int64 {
	for _, line := range strings.Split(data, "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, _ := strconv.ParseInt(fields[1], 10, 64)
				return kb / 1024
			}
		}
	}
	return 0
}

// lsblkOutput matches the JSON output of `lsblk -J`.
type lsblkOutput struct {
	BlockDevices []lsblkDevice `json:"blockdevices"`
}

type lsblkDevice struct {
	Name       string        `json:"name"`
	Size       int64         `json:"size"`
	Model      *string       `json:"model"`
	Type       string        `json:"type"`
	MountPoint *string       `json:"mountpoint"`
	FSType     *string       `json:"fstype"`
	Label      *string       `json:"label"`
	Children   []lsblkDevice `json:"children"`
}

func parseLsblkJSON(data []byte) []DiskInfo {
	var out lsblkOutput
	if err := json.Unmarshal(data, &out); err != nil {
		return nil
	}

	var disks []DiskInfo
	for _, dev := range out.BlockDevices {
		if dev.Type != "disk" {
			continue
		}
		d := DiskInfo{
			Name:      dev.Name,
			SizeBytes: dev.Size,
			Model:     ptrVal(dev.Model),
		}
		for _, child := range dev.Children {
			d.Partitions = append(d.Partitions, PartitionInfo{
				Name:       child.Name,
				MountPoint: ptrVal(child.MountPoint),
				FSType:     ptrVal(child.FSType),
				SizeBytes:  child.Size,
				Label:      ptrVal(child.Label),
			})
		}
		disks = append(disks, d)
	}
	return disks
}

func ptrVal(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// readSysNetNICs reads NICs from /sys/class/net/.
func readSysNetNICs() []NICInfo {
	entries, err := os.ReadDir("/sys/class/net")
	if err != nil {
		return nil
	}

	var nics []NICInfo
	for _, e := range entries {
		name := e.Name()
		if name == "lo" {
			continue
		}

		nic := NICInfo{Name: name}

		// MAC address
		iface, err := net.InterfaceByName(name)
		if err == nil && len(iface.HardwareAddr) > 0 {
			nic.MACAddress = iface.HardwareAddr.String()
		}

		// Driver (via readlink on /sys/class/net/<name>/device/driver)
		driverLink := filepath.Join("/sys/class/net", name, "device", "driver")
		if target, err := os.Readlink(driverLink); err == nil {
			nic.Driver = filepath.Base(target)
		}

		nics = append(nics, nic)
	}
	return nics
}
