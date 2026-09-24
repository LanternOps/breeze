// winsystem_args.go — the pure pieces of the real WinSystem
// (winsystem_windows.go): argument builders, path and IOCTL-buffer parsing,
// the virtdisk.h struct layouts and the LoadHive privilege wrapper, kept
// untagged so winsystem_args_test.go pins them on every host. Layouts are
// for 64-bit Windows (amd64/arm64), the only Windows agent targets.
package rebuild

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

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

// fileDeviceDisk is FILE_DEVICE_DISK (winioctl.h): the STORAGE_DEVICE_NUMBER
// DeviceType of a volume on a real (or attached virtual) disk. CD-ROMs
// (FILE_DEVICE_CD_ROM) and WinPE's X: RAM disk report something else.
const fileDeviceDisk = 0x00000007

// storageDeviceNumberResult is STORAGE_DEVICE_NUMBER (DeviceType u32@0,
// DeviceNumber u32@4, PartitionNumber u32@8).
type storageDeviceNumberResult struct {
	DeviceType, DeviceNumber, PartitionNumber uint32
}

// errNotADiskDevice marks an IOCTL failure that is a definite "this
// device does not answer disk/volume queries" (ERROR_INVALID_FUNCTION,
// ERROR_NOT_SUPPORTED) — the real seam wraps those with it; every other
// failure (including a device that cannot be opened) stays unwrapped.
var errNotADiskDevice = errors.New("device does not support disk queries")

// classifyVolume decides whether one host volume belongs to diskNumber for
// VolumesOnDisk. IOCTL_STORAGE_GET_DEVICE_NUMBER answers for every volume
// on a basic disk; it fails for dynamic-disk volumes (simple, spanned,
// mirrored), and then the disk extents decide: an extent on diskNumber is
// an error, never a silent skip — the preflight Windows-tree guard and
// WipeDisk's lock/dismount both rely on this list being complete. A volume
// is skipped only on a definite answer: its number or extents are
// elsewhere, or BOTH IOCTLs report errNotADiskDevice (WinPE's X: RAM disk).
// A device that cannot be opened, or whose IOCTLs fail for any other
// reason, is an error (fail closed): it could be on diskNumber.
func classifyVolume(vol string, diskNumber int, dn storageDeviceNumberResult, dnErr error, extents func() ([]int, error)) (include bool, partitionNumber int, err error) {
	if dnErr == nil {
		if dn.DeviceType != fileDeviceDisk || int(dn.DeviceNumber) != diskNumber {
			return false, 0, nil
		}
		return true, int(dn.PartitionNumber), nil
	}
	disks, extErr := extents()
	if extErr != nil {
		if errors.Is(dnErr, errNotADiskDevice) && errors.Is(extErr, errNotADiskDevice) {
			return false, 0, nil
		}
		return false, 0, fmt.Errorf("volume %s cannot be placed on or off disk %d (device number: %v; disk extents: %v): refusing to treat the disk as understood", vol, diskNumber, dnErr, extErr)
	}
	for _, d := range disks {
		if d == diskNumber {
			return false, 0, fmt.Errorf("volume %s has an extent on disk %d but is not a basic partition volume (dynamic, spanned or mirrored; %v): refusing to treat the disk as understood", vol, diskNumber, dnErr)
		}
	}
	return false, 0, nil
}

// parseDiskAttributes reads GET_DISK_ATTRIBUTES { ULONG Version; ULONG
// Reserved1; ULONGLONG Attributes } — DISK_ATTRIBUTE_OFFLINE 0x1,
// DISK_ATTRIBUTE_READ_ONLY 0x2 (winioctl.h). A short buffer is an error:
// unknown must not read as online and writable.
func parseDiskAttributes(b []byte) (offline, readOnly bool, err error) {
	if len(b) < 16 {
		return false, false, fmt.Errorf("GET_DISK_ATTRIBUTES returned %d bytes, want 16", len(b))
	}
	attrs := binary.LittleEndian.Uint64(b[8:16])
	return attrs&0x1 != 0, attrs&0x2 != 0, nil
}

// vhdxGeometry normalises CreateVHDX's inputs: the logical sector size is
// 512 or 4096 (anything else → 512, the only other size VHDX supports),
// and the virtual size is rounded up to a multiple of it (VHDX requires
// that; a real source disk size always is, an operator-given image size
// may not be).
func vhdxGeometry(sizeBytes int64, logicalSectorSize int) (uint64, uint32) {
	sector := uint32(512)
	if logicalSectorSize == 4096 {
		sector = 4096
	}
	size := uint64(sizeBytes)
	if rem := size % uint64(sector); rem != 0 {
		size += uint64(sector) - rem
	}
	return size, sector
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
// /Q /Y [/V:<label>]. The real Format passes a temporary drive letter
// ("Z:"): format.com does not accept a \\?\Volume{GUID}\ path.
func formatComArgs(volume, filesystem, label string) []string {
	fs := "NTFS"
	if strings.EqualFold(filesystem, "fat32") || strings.EqualFold(filesystem, "vfat") {
		fs = "FAT32"
	}
	args := []string{volume, "/FS:" + fs, "/Q", "/Y"}
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

// retryTransient runs fn up to attempts times, sleeping delay between
// tries, for as long as its error satisfies transient; any other error —
// or a transient one that outlasts the budget — is returned as is. Used by
// the real HasWindowsTree (winsystem_windows.go): a volume that has just
// arrived answers ERROR_INVALID_PARAMETER briefly before it settles.
func retryTransient(attempts int, delay time.Duration, transient func(error) bool, fn func() error) error {
	var err error
	for i := 0; i < attempts; i++ {
		if err = fn(); err == nil || !transient(err) {
			return err
		}
		if i < attempts-1 {
			time.Sleep(delay)
		}
	}
	return err
}

// withTemporaryLetter gives volumeGUIDPath a drive letter (assign — the
// real seam's AssignLetter) for the duration of fn only: format.com refuses
// a \\?\Volume{GUID}\ path. The letter is released on every path, and a
// release failure is joined to fn's error, never dropped: a letter that
// outlives the call breaks the run's no-letters contract.
func withTemporaryLetter(volumeGUIDPath string, assign func(string) (string, func() error, error), fn func(letter string) error) (err error) {
	letter, release, err := assign(volumeGUIDPath)
	if err != nil {
		return fmt.Errorf("format %s: temporary drive letter: %w", volumeGUIDPath, err)
	}
	defer func() {
		if rerr := release(); rerr != nil {
			err = errors.Join(err, fmt.Errorf("format %s: release temporary drive letter %s: %w", volumeGUIDPath, letter, rerr))
		}
	}()
	return fn(letter)
}
