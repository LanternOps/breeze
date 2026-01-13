package collector

import (
	"fmt"
	"net"
	"os"
	"runtime"
	"strings"

	"github.com/breeze-rmm/agent/pkg/models"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
	psnet "github.com/shirou/gopsutil/v3/net"
	"go.uber.org/zap"
)

// HardwareCollector collects static hardware information about the system.
// This includes CPU, memory, disk, and network interface details.
type HardwareCollector struct {
	BaseCollector
}

// NewHardwareCollector creates a new HardwareCollector with the given logger
func NewHardwareCollector(logger *zap.Logger) *HardwareCollector {
	return &HardwareCollector{
		BaseCollector: NewBaseCollector(logger),
	}
}

// Name returns the collector's name
func (h *HardwareCollector) Name() string {
	return "hardware"
}

// Collect gathers hardware information and returns models.HardwareInfo.
// It collects CPU, memory, disk, and network information.
// Partial failures are logged as warnings but don't prevent other data collection.
func (h *HardwareCollector) Collect() (interface{}, error) {
	h.LogDebug("Starting hardware collection")

	info := models.HardwareInfo{}
	var collectionErrors []string

	// Collect CPU information
	cpuInfo, err := h.collectCPU()
	if err != nil {
		h.LogWarning("Failed to collect CPU info", zap.Error(err))
		collectionErrors = append(collectionErrors, fmt.Sprintf("CPU: %v", err))
	} else {
		info.CPU = cpuInfo
	}

	// Collect memory information
	memInfo, err := h.collectMemory()
	if err != nil {
		h.LogWarning("Failed to collect memory info", zap.Error(err))
		collectionErrors = append(collectionErrors, fmt.Sprintf("Memory: %v", err))
	} else {
		info.Memory = memInfo
	}

	// Collect disk information
	diskInfo, err := h.collectDisks()
	if err != nil {
		h.LogWarning("Failed to collect disk info", zap.Error(err))
		collectionErrors = append(collectionErrors, fmt.Sprintf("Disk: %v", err))
	} else {
		info.Disks = diskInfo
	}

	// Collect network information
	netInfo, err := h.collectNetwork()
	if err != nil {
		h.LogWarning("Failed to collect network info", zap.Error(err))
		collectionErrors = append(collectionErrors, fmt.Sprintf("Network: %v", err))
	} else {
		info.Network = netInfo
	}

	// Collect BIOS information
	biosInfo, err := h.collectBIOS()
	if err != nil {
		h.LogWarning("Failed to collect BIOS info", zap.Error(err))
		// BIOS info is optional, don't add to errors
	} else {
		info.BIOS = biosInfo
	}

	h.LogDebug("Hardware collection completed",
		zap.Int("disks", len(info.Disks)),
		zap.Int("networkInterfaces", len(info.Network)),
		zap.Int("errors", len(collectionErrors)))

	// Return error only if all collections failed
	if len(collectionErrors) == 4 {
		return info, fmt.Errorf("all hardware collectors failed: %v", collectionErrors)
	}

	return info, nil
}

// collectCPU gathers CPU information
func (h *HardwareCollector) collectCPU() (models.CPUInfo, error) {
	cpuInfo := models.CPUInfo{}

	// Get CPU info (model, vendor, etc.)
	infos, err := cpu.Info()
	if err != nil {
		return cpuInfo, fmt.Errorf("failed to get CPU info: %w", err)
	}

	if len(infos) > 0 {
		cpuInfo.Model = infos[0].ModelName
		cpuInfo.Vendor = infos[0].VendorID
		cpuInfo.Family = infos[0].Family
		cpuInfo.BaseSpeed = uint64(infos[0].Mhz)
	}

	// Get physical core count
	physicalCores, err := cpu.Counts(false)
	if err != nil {
		h.LogWarning("Failed to get physical CPU cores", zap.Error(err))
	} else {
		cpuInfo.Cores = physicalCores
	}

	// Get logical core (thread) count
	logicalCores, err := cpu.Counts(true)
	if err != nil {
		h.LogWarning("Failed to get logical CPU cores", zap.Error(err))
	} else {
		cpuInfo.Threads = logicalCores
	}

	return cpuInfo, nil
}

// collectMemory gathers memory information
func (h *HardwareCollector) collectMemory() (models.MemoryInfo, error) {
	memInfo := models.MemoryInfo{}

	// Get virtual memory stats
	vmem, err := mem.VirtualMemory()
	if err != nil {
		return memInfo, fmt.Errorf("failed to get memory info: %w", err)
	}

	memInfo.Total = vmem.Total
	memInfo.Available = vmem.Available
	memInfo.Used = vmem.Used
	memInfo.UsedPct = vmem.UsedPercent

	// Get swap memory stats
	swap, err := mem.SwapMemory()
	if err != nil {
		h.LogWarning("Failed to get swap memory info", zap.Error(err))
	} else {
		memInfo.SwapTotal = swap.Total
		memInfo.SwapUsed = swap.Used
	}

	return memInfo, nil
}

// collectDisks gathers information about all mounted disks
func (h *HardwareCollector) collectDisks() ([]models.DiskInfo, error) {
	var disks []models.DiskInfo

	// Get all partitions
	partitions, err := disk.Partitions(false) // false = only physical devices
	if err != nil {
		return disks, fmt.Errorf("failed to get disk partitions: %w", err)
	}

	for _, partition := range partitions {
		// Skip certain filesystem types
		if h.shouldSkipPartition(partition) {
			continue
		}

		diskInfo := models.DiskInfo{
			Device:     partition.Device,
			MountPoint: partition.Mountpoint,
			FSType:     partition.Fstype,
		}

		// Get usage statistics for this partition
		usage, err := disk.Usage(partition.Mountpoint)
		if err != nil {
			h.LogWarning("Failed to get disk usage",
				zap.String("device", partition.Device),
				zap.String("mountpoint", partition.Mountpoint),
				zap.Error(err))
			// Still add the disk, just without usage info
		} else {
			diskInfo.Total = usage.Total
			diskInfo.Used = usage.Used
			diskInfo.Free = usage.Free
			diskInfo.UsedPct = usage.UsedPercent
		}

		disks = append(disks, diskInfo)
	}

	if len(disks) == 0 {
		return disks, fmt.Errorf("no disks found")
	}

	return disks, nil
}

// shouldSkipPartition returns true if the partition should be skipped
func (h *HardwareCollector) shouldSkipPartition(partition disk.PartitionStat) bool {
	// Skip pseudo filesystems and special mounts
	skipTypes := map[string]bool{
		"devfs":       true,
		"devtmpfs":    true,
		"tmpfs":       true,
		"squashfs":    true,
		"overlay":     true,
		"aufs":        true,
		"proc":        true,
		"sysfs":       true,
		"cgroup":      true,
		"cgroup2":     true,
		"debugfs":     true,
		"securityfs":  true,
		"pstore":      true,
		"configfs":    true,
		"fusectl":     true,
		"mqueue":      true,
		"hugetlbfs":   true,
		"binfmt_misc": true,
	}

	return skipTypes[partition.Fstype]
}

// collectNetwork gathers network interface information
func (h *HardwareCollector) collectNetwork() ([]models.NetworkInfo, error) {
	var interfaces []models.NetworkInfo

	// Get network interfaces from gopsutil
	psInterfaces, err := psnet.Interfaces()
	if err != nil {
		return interfaces, fmt.Errorf("failed to get network interfaces: %w", err)
	}

	// Also get net.Interfaces for additional info
	goInterfaces, err := net.Interfaces()
	if err != nil {
		h.LogWarning("Failed to get Go net interfaces", zap.Error(err))
	}

	// Create a map of Go interfaces for quick lookup
	goInterfaceMap := make(map[string]net.Interface)
	for _, iface := range goInterfaces {
		goInterfaceMap[iface.Name] = iface
	}

	for _, iface := range psInterfaces {
		// Collect IP addresses
		var ips []string
		for _, addr := range iface.Addrs {
			ips = append(ips, addr.Addr)
		}

		netInfo := models.NetworkInfo{
			Name: iface.Name,
			MAC:  iface.HardwareAddr,
			IPs:  ips,
		}

		// Check if interface is up and if it's a loopback
		if goIface, ok := goInterfaceMap[iface.Name]; ok {
			netInfo.IsUp = goIface.Flags&net.FlagUp != 0
			netInfo.IsLoopback = goIface.Flags&net.FlagLoopback != 0
		}

		interfaces = append(interfaces, netInfo)
	}

	if len(interfaces) == 0 {
		return interfaces, fmt.Errorf("no network interfaces found")
	}

	return interfaces, nil
}

// collectBIOS gathers BIOS information (platform-specific)
func (h *HardwareCollector) collectBIOS() (models.BIOSInfo, error) {
	biosInfo := models.BIOSInfo{}

	// Use gopsutil host info for BIOS details
	hostInfo, err := host.Info()
	if err != nil {
		return biosInfo, fmt.Errorf("failed to get host info: %w", err)
	}

	// BIOS info availability varies by platform
	switch runtime.GOOS {
	case "windows":
		// On Windows, we might get BIOS info from host info
		// Additional implementation could use WMI queries
		biosInfo.Vendor = "Unknown"
		biosInfo.Version = "Unknown"
	case "linux":
		// On Linux, BIOS info can be read from /sys/class/dmi/id/
		biosInfo = h.collectLinuxBIOS()
	case "darwin":
		// macOS doesn't have traditional BIOS, use system info
		biosInfo.Vendor = "Apple Inc."
		biosInfo.Version = hostInfo.KernelVersion
	}

	return biosInfo, nil
}

// collectLinuxBIOS reads BIOS info from sysfs (Linux only)
func (h *HardwareCollector) collectLinuxBIOS() models.BIOSInfo {
	biosInfo := models.BIOSInfo{}

	// These files may not exist or may require root access
	biosFiles := map[string]*string{
		"/sys/class/dmi/id/bios_vendor":  &biosInfo.Vendor,
		"/sys/class/dmi/id/bios_version": &biosInfo.Version,
		"/sys/class/dmi/id/bios_date":    &biosInfo.Date,
	}

	for path, dest := range biosFiles {
		if data, err := readFileContent(path); err == nil {
			*dest = data
		}
	}

	return biosInfo
}

// readFileContent reads a file and returns its content as a trimmed string
func readFileContent(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}
