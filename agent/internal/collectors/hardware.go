package collectors

import (
	"runtime"

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
		info.Hostname = hostInfo.Hostname
		info.OSType = normalizeOSType(hostInfo.OS)
		info.OSVersion = hostInfo.Platform + " " + hostInfo.PlatformVersion
		info.OSBuild = hostInfo.KernelVersion
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

	// Disk
	diskUsage, err := disk.Usage("/")
	if err == nil {
		hw.DiskTotalGB = diskUsage.Total / 1024 / 1024 / 1024
	}

	// Platform-specific: serial number, manufacturer, model, BIOS, GPU
	collectPlatformHardware(hw)

	return hw, nil
}
