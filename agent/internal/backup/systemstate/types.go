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
	// Empty/omitted only if hashing failed at collection time, or if this
	// artifact is a symlink (see LinkTarget) — a symlink has no independent
	// file content to hash.
	Checksum string `json:"checksum,omitempty"`

	// LinkTarget is set when this artifact is a symlink rather than a
	// regular file — the readlink(2) target, recorded exactly as staged
	// (absolute or relative, whichever the source symlink used; never
	// resolved). When set, SizeBytes is 0 and Checksum is empty, and the
	// publisher does NOT upload any bytes for this artifact (see
	// publishSystemState) — the manifest entry alone is enough for a
	// consumer to recreate the link. Symlinks used to be excluded from the
	// artifact list entirely (see collectArtifactsInDir), which silently
	// lost every one collected (e.g. /etc/systemd/system/*.wants/*.service).
	LinkTarget string `json:"linkTarget,omitempty"`

	// Mode carries the artifact's permission bits at collection time: the
	// low 9 bits (rwxrwxrwx, i.e. os.FileMode.Perm()) OR'd with the
	// setuid/setgid/sticky bits translated into their traditional octal
	// positions (04000/02000/01000 respectively) — i.e. equivalent to a
	// POSIX stat's st_mode & 07777. A BMR restore (Wave 3) chmods the
	// restored file to this value. Zero/omitted on Windows (no POSIX
	// permission bits — Windows collection sets Mode via the same helper,
	// which just yields the low bits Go's os.FileMode reports there) or on
	// an artifact that predates this field.
	Mode uint32 `json:"mode,omitempty"`
	// UID is the artifact's owning user id at collection time, from
	// os.Lstat (never resolved from a symlink's target — see
	// uidGidFromInfo). Omitted (left at the zero value) on Windows, which
	// has no POSIX uid, or if the artifact predates this field. NOTE:
	// omitempty means a genuine uid 0 (root-owned file) also omits — the
	// same accepted tradeoff SnapshotFile.Mode's sibling fields make
	// elsewhere in this codebase; a consumer restoring uid unconditionally
	// (e.g. always chown, defaulting to 0) is unaffected either way.
	UID int `json:"uid,omitempty"`
	// GID is the artifact's owning group id at collection time — see UID.
	GID int `json:"gid,omitempty"`
	// ModTime is the artifact's modification time at collection time, so a
	// BMR restore can set it back on the restored file. Zero/omitted if
	// unavailable or the artifact predates this field.
	ModTime time.Time `json:"modTime,omitempty"`
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
