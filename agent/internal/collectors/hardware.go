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
		info.OSVersion, info.OSBuild = normalizeOSVersionBuild(
			info.OSType, hostInfo.Platform, hostInfo.PlatformVersion, hostInfo.KernelVersion)
		// Platform-specific enrichment (Windows: registry feature label +
		// authoritative build). No-op on other platforms. Best-effort —
		// failures leave the gopsutil-derived values untouched.
		enrichOSInfo(info)
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

// normalizeOSVersionBuild derives a clean, separated OS version and build
// string from gopsutil's host.Info fields.
//
// On Linux/macOS gopsutil already separates these cleanly: PlatformVersion is
// the distro/OS version (e.g. "12.12", "15.7.7") and KernelVersion is the
// build (e.g. "6.8.12-1-pve"). On Windows, however, gopsutil packs the full
// build into BOTH PlatformVersion and KernelVersion (e.g.
// "10.0.26200.8457 Build 26200.8457"), so the naive
// "Platform + ' ' + PlatformVersion" duplicated the build into the version
// column and left both fields verbose (issue #1302). Platform on Windows is
// already the clean product name including the correct major release
// ("Microsoft Windows 11 Pro" — gopsutil resolves the Win11-reports-10
// registry quirk), so we use it verbatim as the version and extract just the
// build.UBR for the build column.
//
// This is a pure function (no syscalls) so it is fully unit-testable and
// produces correct output even when the Windows registry enrichment in
// enrichOSInfo is unavailable.
func normalizeOSVersionBuild(osType, platform, platformVersion, kernelVersion string) (osVersion, osBuild string) {
	platform = strings.TrimSpace(platform)
	platformVersion = strings.TrimSpace(platformVersion)
	kernelVersion = strings.TrimSpace(kernelVersion)

	if osType == "windows" {
		// Version = product name only (build-free). Build = the canonical
		// "<CurrentBuildNumber>.<UBR>" extracted from the gopsutil string.
		build := platformVersion
		if build == "" {
			build = kernelVersion
		}
		return platform, extractWindowsBuild(build)
	}

	// Non-Windows: preserve gopsutil's already-clean separation.
	osVersion = strings.TrimSpace(platform + " " + platformVersion)
	return osVersion, kernelVersion
}

// extractWindowsBuild reduces a gopsutil Windows version string to the
// canonical "<build>.<UBR>" form admins recognize. Inputs seen in the wild:
//   - "10.0.26200.8457 Build 26200.8457" -> "26200.8457"
//   - "10.0.26200.8457"                  -> "26200.8457"
//   - "26200.8457"                       -> "26200.8457"
//
// Anything unrecognized is returned trimmed and unchanged so we never lose
// information.
func extractWindowsBuild(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	// Prefer the explicit "Build <x>" token (case-insensitive); take the last.
	if idx := strings.LastIndex(strings.ToLower(v), "build "); idx >= 0 {
		if tail := strings.TrimSpace(v[idx+len("build "):]); tail != "" {
			return tail
		}
	}
	// Else strip a leading NT major.minor ("10.0.") from a dotted quad.
	if strings.HasPrefix(v, "10.0.") {
		return strings.TrimPrefix(v, "10.0.")
	}
	return v
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
