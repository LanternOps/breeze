package collectors

import (
	"log/slog"
	"os"
	"runtime"
	"strings"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
)

type HardwareInfo struct {
	CPUModel     string `json:"cpuModel"`
	CPUCores     int    `json:"cpuCores"`
	CPUThreads   int    `json:"cpuThreads"`
	RAMTotalMB   uint64 `json:"ramTotalMb"`
	DiskTotalGB  uint64 `json:"diskTotalGb"`
	GPUModel     string `json:"gpuModel,omitempty"`
	SerialNumber string `json:"serialNumber,omitempty"`
	Manufacturer string `json:"manufacturer,omitempty"`
	Model        string `json:"model,omitempty"`
	BIOSVersion  string `json:"biosVersion,omitempty"`
	ChassisType  string `json:"chassisType,omitempty"`
}

type SystemInfo struct {
	Hostname     string `json:"hostname"`
	OSType       string `json:"osType"`
	OSVersion    string `json:"osVersion"`
	OSBuild      string `json:"osBuild,omitempty"`
	Architecture string `json:"architecture"`
}

type HardwareCollector struct{}

func NewHardwareCollector() *HardwareCollector {
	return &HardwareCollector{}
}

func (c *HardwareCollector) CollectSystemInfo() (*SystemInfo, error) {
	info := &SystemInfo{
		Architecture: runtime.GOARCH,
	}

	hostInfo, err := host.Info()
	if err == nil {
		info.OSType = normalizeOSType(hostInfo.OS)
		info.OSVersion = hostInfo.Platform + " " + hostInfo.PlatformVersion
		info.OSBuild = hostInfo.KernelVersion
	}

	// Resolve hostname via the fallback chain (os.Hostname → platform
	// sources). gopsutil's hostInfo.Hostname is just os.Hostname() with
	// no fallbacks, so relying on it lets empty values through on
	// Windows service-start edge cases. See issue #439.
	if resolved, rhErr := resolveHostnameFn(); rhErr == nil {
		info.Hostname = resolved
	} else {
		slog.Warn("hostname resolution failed", "error", rhErr.Error())
	}

	// On macOS, prefer LocalHostName (e.g. "MacBook-Pro-3") over the
	// short DNS hostname (e.g. "Mac") which can be generic.
	if runtime.GOOS == "darwin" {
		if out, scErr := runCollectorOutput(collectorShortCommandTimeout, "scutil", "--get", "LocalHostName"); scErr == nil {
			if name := strings.TrimSpace(string(out)); name != "" {
				info.Hostname = truncateCollectorString(name)
			}
		}
	}

	return info, nil
}

func normalizeOSType(os string) string {
	if os == "darwin" {
		return "macos"
	}
	return os
}

func (c *HardwareCollector) CollectHardware() (*HardwareInfo, error) {
	hw := &HardwareInfo{}

	// CPU info
	cpuInfo, err := cpu.Info()
	if err == nil && len(cpuInfo) > 0 {
		hw.CPUModel = cpuInfo[0].ModelName
		hw.CPUCores = int(cpuInfo[0].Cores)
	}

	// Logical CPU count (threads)
	counts, err := cpu.Counts(true)
	if err == nil {
		hw.CPUThreads = counts
	}

	// Memory
	vmem, err := mem.VirtualMemory()
	if err == nil {
		hw.RAMTotalMB = vmem.Total / 1024 / 1024
	}

	// Disk — use platform-appropriate root path
	rootPath := "/"
	if runtime.GOOS == "windows" {
		rootPath = os.Getenv("SystemDrive") + "\\"
		if rootPath == "\\" {
			rootPath = "C:\\"
		}
	}
	diskUsage, err := disk.Usage(rootPath)
	if err == nil {
		hw.DiskTotalGB = diskUsage.Total / 1024 / 1024 / 1024
	}

	// Chassis type for role classification
	hw.ChassisType = getChassisType()

	// Platform-specific: serial number, manufacturer, model, BIOS, GPU
	collectPlatformHardware(hw)

	return hw, nil
}
