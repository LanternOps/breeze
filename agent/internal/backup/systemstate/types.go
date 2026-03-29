// Package systemstate captures OS-critical configuration for enterprise backup.
// Platform-specific collectors gather registry hives, boot config, service
// lists, package inventories, and hardware profiles so that a bare-metal
// recovery can restore the full machine state.
package systemstate

import "time"

// SystemStateManifest describes all collected system state artifacts.
type SystemStateManifest struct {
	Platform        string           `json:"platform"`
	OSVersion       string           `json:"osVersion"`
	Hostname        string           `json:"hostname"`
	CollectedAt     time.Time        `json:"collectedAt"`
	Artifacts       []Artifact       `json:"artifacts"`
	HardwareProfile *HardwareProfile `json:"hardwareProfile,omitempty"`
}

// Artifact is a single collected system state item.
type Artifact struct {
	Name      string `json:"name"`      // e.g. "registry_SYSTEM", "etc_tree"
	Category  string `json:"category"`  // registry, boot, drivers, certs, services, packages, config
	Path      string `json:"path"`      // path within staging dir
	SizeBytes int64  `json:"sizeBytes"`
}

// HardwareProfile captures machine hardware for recovery planning.
type HardwareProfile struct {
	CPUModel        string     `json:"cpuModel"`
	CPUCores        int        `json:"cpuCores"`
	TotalMemoryMB   int64      `json:"totalMemoryMB"`
	Disks           []DiskInfo `json:"disks"`
	NetworkAdapters []NICInfo  `json:"networkAdapters"`
	BIOSVersion     string     `json:"biosVersion,omitempty"`
	IsUEFI          bool       `json:"isUefi"`
	Motherboard     string     `json:"motherboard,omitempty"`
}

// DiskInfo describes a physical disk.
type DiskInfo struct {
	Name       string          `json:"name"`
	SizeBytes  int64           `json:"sizeBytes"`
	Model      string          `json:"model,omitempty"`
	Partitions []PartitionInfo `json:"partitions,omitempty"`
}

// PartitionInfo describes a disk partition or logical volume.
type PartitionInfo struct {
	Name       string `json:"name"`
	MountPoint string `json:"mountPoint"`
	FSType     string `json:"fsType"`
	SizeBytes  int64  `json:"sizeBytes"`
	UsedBytes  int64  `json:"usedBytes"`
	Label      string `json:"label,omitempty"`
}

// NICInfo describes a network interface.
type NICInfo struct {
	Name       string `json:"name"`
	MACAddress string `json:"macAddress"`
	Driver     string `json:"driver,omitempty"`
}

// Collector is the platform-specific system state collector.
type Collector interface {
	// CollectState gathers system state artifacts into stagingDir.
	CollectState(stagingDir string) (*SystemStateManifest, error)
	// CollectHardwareProfile captures hardware info without full state collection.
	CollectHardwareProfile() (*HardwareProfile, error)
}
