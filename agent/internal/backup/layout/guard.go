package layout

import (
	"fmt"
	"strings"
)

// Reason strings are operator-facing and asserted by tests — never reword
// them in a caller.
const (
	ReasonNilManifest    = "no disk layout was captured"
	ReasonBIOSBoot       = "boot mode is BIOS/MBR; only UEFI with GPT is supported"
	ReasonNoSystemDisk   = "no disk holds the root filesystem"
	ReasonNotGPT         = "system disk is not GPT-partitioned"
	ReasonNoEFIPartition = "no EFI system partition on the system disk"
	ReasonNoRoot         = "no root filesystem found on the system disk"
	ReasonMultiDisk      = "the operating system tree is spread across more than one disk"
	ReasonLVM            = "LVM volumes are not supported"
	ReasonLUKS           = "LUKS/dm-crypt encrypted volumes are not supported"
	ReasonRAID           = "software RAID members are not supported"
	ReasonBtrfs          = "btrfs root filesystem is not supported"
	ReasonZFS            = "ZFS is not supported"
)

// ReasonUnsupportedRootFS formats the root-filesystem reason for fs.
func ReasonUnsupportedRootFS(fs string) string {
	return fmt.Sprintf("root filesystem type %q is not supported (ext4, xfs, ntfs)", fs)
}

var supportedRootFS = map[string]bool{"ext4": true, "xfs": true, "ntfs": true}

// systemMountPoints are the mount points that must live on the system disk
// for a single-disk rebuild to reproduce the OS tree. Anything else on a
// second disk is user data the file backup still captures but the rebuild
// does not have to place.
var systemMountPoints = map[string]bool{
	"/": true, "/boot": true, "/boot/efi": true, "/efi": true,
	"/usr": true, "/var": true, "/etc": true, "/opt": true, "/home": true,
}

// Assess decides whether the rebuild engine (spec §6) can reproduce m.
// Reasons are appended in a fixed order: boot mode, system-disk checks,
// then the feature scan — so the output is deterministic for a given input.
func Assess(m *Manifest) Restorability {
	if m == nil {
		return Restorability{Restorable: false, Reasons: []string{ReasonNilManifest}}
	}
	reasons := []string{}
	if m.BootMode != BootModeUEFI {
		reasons = append(reasons, ReasonBIOSBoot)
	}
	sys := m.SystemDisk()
	if sys == nil {
		reasons = append(reasons, ReasonNoSystemDisk)
	} else {
		if !strings.EqualFold(sys.TableType, "gpt") {
			reasons = append(reasons, ReasonNotGPT)
		}
		if sys.partitionWithRole(RoleEFI) == nil {
			reasons = append(reasons, ReasonNoEFIPartition)
		}
		if root := sys.partitionWithRole(RoleRoot); root == nil {
			reasons = append(reasons, ReasonNoRoot)
		} else if !supportedRootFS[strings.ToLower(root.Filesystem)] {
			reasons = append(reasons, ReasonUnsupportedRootFS(root.Filesystem))
		}
	}

	var lvm, luks, raid, btrfs, zfs, multi bool
	for i := range m.Disks {
		d := &m.Disks[i]
		if d.Removable {
			continue
		}
		onSystemDisk := sys != nil && d == sys
		for _, p := range d.Partitions {
			fs := strings.ToLower(p.Filesystem)
			// A dependency of the OS tree is any partition on the system disk,
			// or any partition anywhere mounted at a system mount point.
			dependency := onSystemDisk || systemMountPoints[p.MountPoint]
			if sys != nil && !onSystemDisk && systemMountPoints[p.MountPoint] {
				multi = true
			}
			if !dependency {
				continue
			}
			switch {
			case p.Kind == "lvm", fs == "lvm2_member", strings.EqualFold(p.TypeGUID, GUIDLinuxLVM):
				lvm = true
			case p.Kind == "crypt", fs == "crypto_luks", p.Encryption == EncryptionLUKS:
				luks = true
			case strings.HasPrefix(p.Kind, "raid"), fs == "linux_raid_member", strings.EqualFold(p.TypeGUID, GUIDLinuxRAID):
				raid = true
			case fs == "btrfs" && isRootMount(p.MountPoint):
				btrfs = true
			case fs == "zfs_member":
				zfs = true
			}
		}
	}
	if multi {
		reasons = append(reasons, ReasonMultiDisk)
	}
	if lvm {
		reasons = append(reasons, ReasonLVM)
	}
	if luks {
		reasons = append(reasons, ReasonLUKS)
	}
	if raid {
		reasons = append(reasons, ReasonRAID)
	}
	if btrfs {
		reasons = append(reasons, ReasonBtrfs)
	}
	if zfs {
		reasons = append(reasons, ReasonZFS)
	}
	return Restorability{Restorable: len(reasons) == 0, Reasons: reasons}
}
