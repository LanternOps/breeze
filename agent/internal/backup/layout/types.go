// Package layout captures a machine's disk layout at backup time
// (snapshots/<id>/layout.json) and decides whether the bare-metal rebuild
// engine can reproduce it. Spec: docs/superpowers/specs/backup/
// 2026-09-10-bare-metal-boot-media-recovery-design.md §5.2-5.3.
package layout

import (
	"errors"
	"time"
)

// SchemaVersion is written into every manifest. Bump on incompatible changes;
// the rebuild engine refuses versions it does not know.
const SchemaVersion = 1

// ErrUnsupportedPlatform is returned by Collect on platforms without a
// collector (darwin, others). The backup run records it as a warning.
var ErrUnsupportedPlatform = errors.New("disk layout capture is not supported on this platform")

// Boot modes.
const (
	BootModeUEFI    = "uefi"
	BootModeBIOS    = "bios"
	BootModeUnknown = "unknown"
)

// Partition roles — how the rebuild engine will treat the partition.
const (
	RoleEFI      = "efi"
	RoleRoot     = "root"
	RoleBoot     = "boot"
	RoleSwap     = "swap"
	RoleData     = "data"
	RoleMSR      = "msr"
	RoleRecovery = "recovery"
	RoleUnknown  = "unknown"
)

// Encryption kinds.
const (
	EncryptionNone      = "none"
	EncryptionLUKS      = "luks"
	EncryptionBitLocker = "bitlocker"
)

// Well-known GPT partition type GUIDs (lower-case, no braces).
const (
	GUIDEFISystem       = "c12a7328-f81f-11d2-ba4b-00a0c93ec93b"
	GUIDMicrosoftMSR    = "e3c9e316-0b5c-4db8-817d-f92df00215ae"
	GUIDMicrosoftBasic  = "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7"
	GUIDWindowsRecovery = "de94bba4-06d1-4d40-a16a-bfd50179d6ac"
	GUIDLinuxFilesystem = "0fc63daf-8483-4772-8e79-3d69d8477de4"
	GUIDLinuxSwap       = "0657fd6d-a4ab-43c4-84e5-0933c84b4f4f"
	GUIDLinuxLVM        = "e6d6d379-f507-44c2-a23c-238f2a3df928"
	GUIDLinuxRAID       = "a19d880f-05fc-4d3b-a006-743f0f84911e"
	GUIDLinuxLUKS       = "ca7d7ccb-63ed-4c53-861c-1742536059cc"
)

// Manifest is the on-disk/JSON shape of snapshots/<id>/layout.json.
type Manifest struct {
	SchemaVersion int        `json:"schemaVersion"`
	CollectedAt   time.Time  `json:"collectedAt"`
	Platform      string     `json:"platform"` // "linux" | "windows"
	OSRelease     string     `json:"osRelease,omitempty"`
	Hostname      string     `json:"hostname,omitempty"`
	BootMode      string     `json:"bootMode"`
	Disks         []Disk     `json:"disks"`
	EFIEntries    []EFIEntry `json:"efiEntries,omitempty"`
	Fstab         string     `json:"fstab,omitempty"` // verbatim /etc/fstab (Linux)
	// Incomplete names optional collection steps that failed ("efi_entries",
	// "fstab", "os_release", "bitlocker"). Diagnostic only — Assess does not
	// consult it, because none of these steps is required to rebuild.
	Incomplete []string `json:"incomplete,omitempty"`
}

// Disk is one physical disk.
type Disk struct {
	Name       string      `json:"name"` // /dev/sda, \\.\PHYSICALDRIVE0
	Model      string      `json:"model,omitempty"`
	Serial     string      `json:"serial,omitempty"`
	SizeBytes  int64       `json:"sizeBytes"`
	SectorSize int         `json:"sectorSize,omitempty"`
	TableType  string      `json:"tableType"` // "gpt" | "mbr" | "none" | "unknown"
	Removable  bool        `json:"removable,omitempty"`
	IsSystem   bool        `json:"isSystem"` // holds the partition mounted at / (Linux) or C:\ (Windows)
	Partitions []Partition `json:"partitions"`
}

// Partition is one partition (or, for Kind != "", a non-partition block child
// such as an LVM logical volume or dm-crypt mapping reported under the disk).
type Partition struct {
	Number     int      `json:"number"`
	Name       string   `json:"name"`
	TypeGUID   string   `json:"typeGuid,omitempty"`
	PartUUID   string   `json:"partUuid,omitempty"`
	StartBytes int64    `json:"startBytes"`
	SizeBytes  int64    `json:"sizeBytes"`
	UsedBytes  int64    `json:"usedBytes,omitempty"` // 0 when not mounted
	Filesystem string   `json:"filesystem,omitempty"`
	FSUUID     string   `json:"fsUuid,omitempty"`
	Label      string   `json:"label,omitempty"`
	MountPoint string   `json:"mountPoint,omitempty"`
	Flags      []string `json:"flags,omitempty"`
	Encryption string   `json:"encryption"`
	Role       string   `json:"role"`
	Kind       string   `json:"kind,omitempty"` // lsblk TYPE for non-"part" children: lvm, crypt, raid1, ...
}

// EFIEntry is one firmware boot entry (efibootmgr -v on Linux).
type EFIEntry struct {
	BootNum string `json:"bootNum"`
	Label   string `json:"label"`
	Path    string `json:"path,omitempty"`
	Active  bool   `json:"active"`
	Current bool   `json:"current"`
}

// Restorability is the guard's verdict, persisted on the snapshot row as
// bare_metal_restorable + bare_metal_reasons and shown in the UI.
type Restorability struct {
	Restorable bool     `json:"restorable"`
	Reasons    []string `json:"reasons"`
}

// SystemDisk returns the disk flagged IsSystem, falling back to the disk that
// holds the partition mounted at / (Linux) or C:\ (Windows). Nil when neither
// exists.
func (m *Manifest) SystemDisk() *Disk {
	if m == nil {
		return nil
	}
	for i := range m.Disks {
		if m.Disks[i].IsSystem {
			return &m.Disks[i]
		}
	}
	for i := range m.Disks {
		for _, p := range m.Disks[i].Partitions {
			if isRootMount(p.MountPoint) {
				return &m.Disks[i]
			}
		}
	}
	return nil
}

func isRootMount(mountPoint string) bool {
	return mountPoint == "/" || mountPoint == `C:\` || mountPoint == "C:"
}

func (d *Disk) partitionWithRole(role string) *Partition {
	for i := range d.Partitions {
		if d.Partitions[i].Role == role {
			return &d.Partitions[i]
		}
	}
	return nil
}
