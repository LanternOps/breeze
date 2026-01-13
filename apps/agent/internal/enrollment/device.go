package enrollment

import (
	"os"
	"runtime"

	"github.com/breeze-rmm/agent/pkg/models"
	"github.com/shirou/gopsutil/v3/host"
)

// AgentVersion is set during build
var AgentVersion = "dev"

// GetDeviceInfo collects all device information for enrollment
func GetDeviceInfo() models.DeviceInfo {
	return models.DeviceInfo{
		Hostname:     GetHostname(),
		OS:           GetOS(),
		OSVersion:    GetOSVersion(),
		Architecture: GetArchitecture(),
		AgentVersion: AgentVersion,
	}
}

// GetHostname returns the system hostname
func GetHostname() string {
	hostname, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return hostname
}

// GetOS returns the operating system name
func GetOS() string {
	return runtime.GOOS
}

// GetOSVersion returns the operating system version
func GetOSVersion() string {
	info, err := host.Info()
	if err != nil {
		return "unknown"
	}

	// Construct version string from available info
	version := info.PlatformVersion
	if info.PlatformFamily != "" {
		version = info.PlatformFamily + " " + version
	}
	if info.KernelVersion != "" && version == "" {
		version = info.KernelVersion
	}

	if version == "" {
		return "unknown"
	}

	return version
}

// GetArchitecture returns the CPU architecture
func GetArchitecture() string {
	return runtime.GOARCH
}

// GetPlatformInfo returns detailed platform information
func GetPlatformInfo() (platform, family, version string) {
	info, err := host.Info()
	if err != nil {
		return "unknown", "unknown", "unknown"
	}
	return info.Platform, info.PlatformFamily, info.PlatformVersion
}

// GetKernelVersion returns the kernel version
func GetKernelVersion() string {
	info, err := host.Info()
	if err != nil {
		return "unknown"
	}
	return info.KernelVersion
}
