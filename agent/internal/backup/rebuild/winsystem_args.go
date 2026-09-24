// winsystem_args.go — the pure pieces of the real WinSystem
// (winsystem_windows.go): argument builders, path and IOCTL-buffer parsing,
// the virtdisk.h struct layouts and the LoadHive privilege wrapper, kept
// untagged so winsystem_args_test.go pins them on every host. Layouts are
// for 64-bit Windows (amd64/arm64), the only Windows agent targets.
package rebuild

import (
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

// ioctlDiskGetDriveGeometryEx = CTL_CODE(IOCTL_DISK_BASE=7, 0x0028,
// METHOD_BUFFERED, FILE_ANY_ACCESS). Output DISK_GEOMETRY_EX: Cylinders
// i64@0, MediaType u32@8, TracksPerCylinder u32@12, SectorsPerTrack u32@16,
// BytesPerSector u32@20, DiskSize i64@24.
const ioctlDiskGetDriveGeometryEx = uint32(0x000700A0)

// ioctlVolumeGetVolumeDiskExtents = CTL_CODE(IOCTL_VOLUME_BASE=0x56, 0,
// METHOD_BUFFERED, FILE_ANY_ACCESS); output VOLUME_DISK_EXTENTS (see
// parseVolumeDiskExtents).
const ioctlVolumeGetVolumeDiskExtents = uint32(0x00560000)

// volumeDiskExtentsHeader/diskExtentSize: VOLUME_DISK_EXTENTS is
// NumberOfDiskExtents u32@0 + 4 bytes padding, then DISK_EXTENT entries
// {DiskNumber u32@0, 4 pad, StartingOffset i64@8, ExtentLength i64@16}.
const (
	volumeDiskExtentsHeader = 8
	diskExtentSize          = 24
)

// parseVolumeDiskExtents returns the disk number of every extent in an
// IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS result.
func parseVolumeDiskExtents(b []byte) ([]int, error) {
	if len(b) < volumeDiskExtentsHeader {
		return nil, fmt.Errorf("VOLUME_DISK_EXTENTS buffer too short (%d bytes)", len(b))
	}
	count := int(binary.LittleEndian.Uint32(b[0:4]))
	if count > (len(b)-volumeDiskExtentsHeader)/diskExtentSize {
		return nil, fmt.Errorf("VOLUME_DISK_EXTENTS claims %d extents in a %d-byte buffer", count, len(b))
	}
	out := make([]int, 0, count)
	for i := 0; i < count; i++ {
		off := volumeDiskExtentsHeader + i*diskExtentSize
		out = append(out, int(binary.LittleEndian.Uint32(b[off:off+4])))
	}
	return out, nil
}

// virtualStorageType is VIRTUAL_STORAGE_TYPE {ULONG DeviceId; GUID
// VendorId} — 20 bytes, 4-byte aligned. VendorID holds the GUID in Win32
// (mixed-endian) byte order.
type virtualStorageType struct {
	DeviceID uint32
	VendorID [16]byte
}

// virtualStorageTypeVHDX: VIRTUAL_STORAGE_TYPE_DEVICE_VHDX (3) +
// VIRTUAL_STORAGE_TYPE_VENDOR_MICROSOFT {EC984AEC-A0F9-47E9-901F-71415A66345B}.
var virtualStorageTypeVHDX = virtualStorageType{
	DeviceID: 3,
	VendorID: [16]byte{0xec, 0x4a, 0x98, 0xec, 0xf9, 0xa0, 0xe9, 0x47, 0x90, 0x1f, 0x71, 0x41, 0x5a, 0x66, 0x34, 0x5b},
}

// createVirtualDiskParametersV2 is CREATE_VIRTUAL_DISK_PARAMETERS with
// Version = CREATE_VIRTUAL_DISK_VERSION_2 (the union is 8-byte aligned, so
// Version2 starts at offset 8). Only the Version2 arm is declared: virtdisk
// reads the arm Version selects, so the larger Version3/4 arms of the C
// union need no backing memory. Pinned by TestVirtdiskStructLayouts.
// ParentPath/SourcePath are always nil here (no differencing/copy-from
// disks), so no Go-heap pointer is hidden from the GC.
type createVirtualDiskParametersV2 struct {
	Version                   uint32
	_                         uint32
	UniqueID                  [16]byte
	MaximumSize               uint64
	BlockSizeInBytes          uint32
	SectorSizeInBytes         uint32
	PhysicalSectorSizeInBytes uint32
	_                         uint32
	ParentPath                *uint16 // PCWSTR
	SourcePath                *uint16 // PCWSTR
	OpenFlags                 uint32
	ParentVirtualStorageType  virtualStorageType
	SourceVirtualStorageType  virtualStorageType
	ResiliencyGUID            [16]byte
}

// openVirtualDiskParametersV2 is OPEN_VIRTUAL_DISK_PARAMETERS with
// Version = OPEN_VIRTUAL_DISK_VERSION_2 (union 4-byte aligned).
type openVirtualDiskParametersV2 struct {
	Version        uint32
	GetInfoOnly    int32 // BOOL
	ReadOnly       int32 // BOOL
	ResiliencyGUID [16]byte
}

// attachVirtualDiskParametersV2 is ATTACH_VIRTUAL_DISK_PARAMETERS with
// Version = ATTACH_VIRTUAL_DISK_VERSION_2; zero RestrictedOffset/Length
// attach the whole disk (the go-winio AttachVhd call shape).
type attachVirtualDiskParametersV2 struct {
	Version          uint32
	_                uint32
	RestrictedOffset uint64
	RestrictedLength uint64
}

const (
	createVirtualDiskVersion2 = 2
	openVirtualDiskVersion2   = 2
	attachVirtualDiskVersion2 = 2
	virtualDiskAccessNone     = 0 // VIRTUAL_DISK_ACCESS_NONE: required with the Version2 create/open parameters
	createVirtualDiskFlagNone = 0 // dynamic (no FULL_PHYSICAL_ALLOCATION)
	openVirtualDiskFlagNone   = 0
	attachFlagNoDriveLetter   = 0x00000002 // ATTACH_VIRTUAL_DISK_FLAG_NO_DRIVE_LETTER; PERMANENT_LIFETIME (0x4) deliberately absent
	detachVirtualDiskFlagNone = 0
	vhdxBlockSizeBytes        = 32 * 1024 * 1024 // Global Constraint: dynamic, 32 MiB block
)

// letterCandidates is AssignLetter's search order: Z down to D (A/B are
// historically reserved, C: is never free on a live host).
func letterCandidates() []byte {
	out := make([]byte, 0, 'Z'-'D'+1)
	for c := byte('Z'); c >= 'D'; c-- {
		out = append(out, c)
	}
	return out
}

// formatComArgs builds format.com's arguments: <volume> /FS:<NTFS|FAT32>
// /Q /Y [/V:<label>]. The volume is a \\?\Volume{GUID}\ path, which
// format.com accepts as the volume argument.
func formatComArgs(volumeGUIDPath, filesystem, label string) []string {
	fs := "NTFS"
	if strings.EqualFold(filesystem, "fat32") || strings.EqualFold(filesystem, "vfat") {
		fs = "FAT32"
	}
	args := []string{volumeGUIDPath, "/FS:" + fs, "/Q", "/Y"}
	if label != "" {
		args = append(args, "/V:"+label)
	}
	return args
}

// volumeDevicePath turns FindFirstVolumeW's \\?\Volume{GUID}\ into the
// \\.\Volume{GUID} device path CreateFile needs to open the volume itself
// (a trailing backslash would open the volume's root directory instead).
func volumeDevicePath(volumeGUIDPath string) string {
	return `\\.\` + strings.TrimPrefix(strings.TrimSuffix(volumeGUIDPath, `\`), `\\?\`)
}

// withTrailingBackslash: SetVolumeMountPointW/DeleteVolumeMountPointW and
// the volume-root forms of every volume path need exactly one.
func withTrailingBackslash(p string) string { return strings.TrimSuffix(p, `\`) + `\` }

// physicalDriveNumber parses GetVirtualDiskPhysicalPath's output
// (\\.\PhysicalDriveN; case and the \\?\ prefix vary by build).
func physicalDriveNumber(path string) (int, error) {
	lower := strings.ToLower(path)
	for _, prefix := range []string{`\\.\physicaldrive`, `\\?\physicaldrive`} {
		if rest, ok := strings.CutPrefix(lower, prefix); ok && rest != "" {
			n, err := strconv.Atoi(rest)
			if err == nil && n >= 0 {
				return n, nil
			}
		}
	}
	return 0, fmt.Errorf("not a physical drive path: %q", path)
}

// hiveWithRelease is what the real LoadHive returns: the loaded hive plus
// the SeBackup/SeRestore scope (backup.AcquireHivePrivileges) held for it.
// Close unloads first — RegUnLoadKeyW needs both privileges — and releases
// after, exactly once; a second Close (winTeardown's backstop after an
// explicit Close) is a no-op.
type hiveWithRelease struct {
	winhive.Handle
	release func()
	once    sync.Once
}

func (h *hiveWithRelease) Close() error {
	var err error
	h.once.Do(func() {
		err = h.Handle.Close()
		h.release()
	})
	return err
}
