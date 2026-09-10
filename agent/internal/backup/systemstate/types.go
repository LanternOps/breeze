// Package systemstate captures OS-critical configuration for enterprise backup.
// Platform-specific collectors gather registry hives, boot config, service
// lists, package inventories, and hardware profiles so that a bare-metal
// recovery can restore the full machine state.
package systemstate

import "time"

// SystemStateManifest describes all collected system state artifacts.
type SystemStateManifest struct {
	Platform    string     `json:"platform"`
	OSVersion   string     `json:"osVersion"`
	Hostname    string     `json:"hostname"`
	CollectedAt time.Time  `json:"collectedAt"`
	Artifacts   []Artifact `json:"artifacts"`
	// IncompleteSteps names the collection steps that failed to run (e.g.
	// "registry", "boot"). System state is collected best-effort — a partial
	// collection still produces a manifest — so this is how callers learn the
	// backup is incomplete instead of it silently passing as a full capture.
	// Empty/omitted means every step succeeded.
	IncompleteSteps []string         `json:"incompleteSteps,omitempty"`
	HardwareProfile *HardwareProfile `json:"hardwareProfile,omitempty"`

	// SchemaVersion identifies the shape of this manifest, so a future
	// consumer-side change can detect and branch on an older manifest
	// explicitly instead of guessing from field presence. Set to 1 by
	// CollectSystemState; every manifest this package produces carries it.
	SchemaVersion int `json:"schemaVersion"`

	// CollectorVersion is the agent/helper version string that produced this
	// manifest. The systemstate package has no notion of "the agent version"
	// itself (it collects OS state, not agent identity), so this is left for
	// the caller to fill in — see backup.BackupConfig.AgentVersion, wired the
	// same way as BackupConfig.AgentID — before the manifest is persisted or
	// published. Empty when the caller didn't set one (e.g. an older backup
	// package build, or a test double).
	CollectorVersion string `json:"collectorVersion,omitempty"`

	// RequiredSteps names the collection steps this platform's collector
	// treats as required for a restorable image (see missingRequired) — e.g.
	// registry and boot on Windows. Serialized so a CONSUMER (bare-metal
	// recovery) can independently enforce the same policy rather than
	// trusting only the producer's own collection-time gate. Empty/omitted
	// when the collecting platform defines no required steps.
	RequiredSteps []string `json:"requiredSteps,omitempty"`
}

// Artifact is a single collected system state item.
type Artifact struct {
	Name      string `json:"name"`     // e.g. "registry_SYSTEM", "etc_tree"
	Category  string `json:"category"` // registry, boot, drivers, certs, services, packages, config
	Path      string `json:"path"`     // path within staging dir
	SizeBytes int64  `json:"sizeBytes"`
	// Checksum is the lowercase-hex SHA-256 of the artifact file, computed at
	// collection time (see artifactFromFile / collectArtifactsInDir). A
	// consumer downloading this artifact from remote storage verifies its
	// bytes against this value before applying it — the same integrity
	// contract backup.SnapshotFile.Checksum gives ordinary backed-up files.
	// Empty/omitted only if hashing failed at collection time.
	Checksum string `json:"checksum,omitempty"`
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
