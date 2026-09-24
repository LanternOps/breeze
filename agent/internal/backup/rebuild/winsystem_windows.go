//go:build windows

// winsystem_windows.go — the real WinSystem: virtdisk.dll for VHDX
// create/attach/detach, volume enumeration and folder mount points, disk
// IOCTLs (GPT layout I/O itself is package wingpt's), format.com through
// Run, and offline hives through winhive under backup.AcquireHivePrivileges.
// No PowerShell, no diskpart. The pure pieces (struct layouts, argument
// builders, parsers) live in the untagged winsystem_args.go.
package rebuild

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/wingpt"
	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

// virtdisk.dll is not wrapped by x/sys. Every virtdisk API returns its
// Win32 error code directly (0 = success) rather than via GetLastError.
var (
	virtdisk                       = windows.NewLazySystemDLL("virtdisk.dll")
	procCreateVirtualDisk          = virtdisk.NewProc("CreateVirtualDisk")
	procOpenVirtualDisk            = virtdisk.NewProc("OpenVirtualDisk")
	procAttachVirtualDisk          = virtdisk.NewProc("AttachVirtualDisk")
	procDetachVirtualDisk          = virtdisk.NewProc("DetachVirtualDisk")
	procGetVirtualDiskPhysicalPath = virtdisk.NewProc("GetVirtualDiskPhysicalPath")
)

// fileDeviceDisk is FILE_DEVICE_DISK (winioctl.h): the STORAGE_DEVICE_NUMBER
// DeviceType of a volume on a real (or attached virtual) disk. CD-ROMs
// (FILE_DEVICE_CD_ROM) and WinPE's X: RAM disk report something else.
const fileDeviceDisk = 0x00000007

// errUnrecognizedVolume is ERROR_UNRECOGNIZED_VOLUME: a RAW (unformatted)
// volume's root cannot be opened.
const errUnrecognizedVolume = windows.Errno(1005)

type winSystemWindows struct {
	mu          sync.Mutex
	vhdxHandles map[string]windows.Handle // path -> open virtual-disk handle while this process holds the attach
}

// NewWinSystem is the real WinSystem.
func NewWinSystem() WinSystem {
	return &winSystemWindows{vhdxHandles: map[string]windows.Handle{}}
}

var _ WinSystem = (*winSystemWindows)(nil)

func (w *winSystemWindows) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func (w *winSystemWindows) LookPath(name string) (string, error) { return exec.LookPath(name) }

func (w *winSystemWindows) InWinPE() bool {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\MiniNT`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	_ = k.Close()
	return true
}

// openDevice opens a disk or volume device path. access 0 is enough for
// the FILE_ANY_ACCESS query IOCTLs and needs no elevation.
func openDevice(devPath string, access uint32) (windows.Handle, error) {
	p, err := windows.UTF16PtrFromString(devPath)
	if err != nil {
		return 0, err
	}
	h, err := windows.CreateFile(p, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return 0, fmt.Errorf("open %s: %w", devPath, err)
	}
	return h, nil
}

// storageDeviceNumber issues IOCTL_STORAGE_GET_DEVICE_NUMBER
// (STORAGE_DEVICE_NUMBER: DeviceType u32@0, DeviceNumber u32@4,
// PartitionNumber u32@8) on a volume or disk device path.
func storageDeviceNumber(devPath string) (devType, devNumber, partNumber uint32, err error) {
	h, err := openDevice(devPath, 0)
	if err != nil {
		return 0, 0, 0, err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var out [3]uint32
	var n uint32
	if err := windows.DeviceIoControl(h, wingpt.IOCTLStorageGetDeviceNumber, nil, 0, (*byte)(unsafe.Pointer(&out[0])), uint32(unsafe.Sizeof(out)), &n, nil); err != nil {
		return 0, 0, 0, err
	}
	return out[0], out[1], out[2], nil
}

// volumeDiskNumbers issues IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS on a volume
// device path and returns the disk number of every extent.
func volumeDiskNumbers(devPath string) ([]int, error) {
	h, err := openDevice(devPath, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	buf := make([]byte, volumeDiskExtentsHeader+64*diskExtentSize)
	var n uint32
	if err := windows.DeviceIoControl(h, ioctlVolumeGetVolumeDiskExtents, nil, 0, &buf[0], uint32(len(buf)), &n, nil); err != nil {
		return nil, fmt.Errorf("IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS %s: %w", devPath, err)
	}
	return parseVolumeDiskExtents(buf[:n])
}

// forEachVolume calls fn with every volume GUID path (\\?\Volume{GUID}\)
// on the host.
func forEachVolume(fn func(volGUIDPath string) error) error {
	var buf [windows.MAX_PATH + 1]uint16
	h, err := windows.FindFirstVolume(&buf[0], uint32(len(buf)))
	if err != nil {
		return fmt.Errorf("FindFirstVolumeW: %w", err)
	}
	defer func() { _ = windows.FindVolumeClose(h) }()
	for {
		if err := fn(windows.UTF16ToString(buf[:])); err != nil {
			return err
		}
		if err := windows.FindNextVolume(h, &buf[0], uint32(len(buf))); err != nil {
			if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
				return nil
			}
			return fmt.Errorf("FindNextVolumeW: %w", err)
		}
	}
}

// SystemDiskNumber: the disk under %SystemRoot%'s volume, from its disk
// extents. In WinPE %SystemRoot% is X:, a RAM disk with no disk extents →
// -1 (the interface contract). A system volume spanning several disks is
// an error: returning one of them would let preflight write to another.
func (w *winSystemWindows) SystemDiskNumber() (int, error) {
	dir, err := windows.GetSystemWindowsDirectory()
	if err != nil {
		return -1, err
	}
	if len(dir) < 2 || dir[1] != ':' {
		return -1, fmt.Errorf("unexpected system directory %q", dir)
	}
	disks, err := volumeDiskNumbers(`\\.\` + dir[:2])
	if err != nil {
		if w.InWinPE() {
			return -1, nil
		}
		return -1, err
	}
	switch len(disks) {
	case 0:
		return -1, nil
	case 1:
		return disks[0], nil
	default:
		return -1, fmt.Errorf("system volume %s spans disks %v", dir[:2], disks)
	}
}

// MediaDiskNumbers: in WinPE, every disk holding a volume with
// \sources\boot.wim (the media the RAM disk was loaded from). A CD/DVD
// medium is not a disk (and cannot be a disk: target), so it is skipped.
// Empty on a live host.
func (w *winSystemWindows) MediaDiskNumbers() ([]int, error) {
	if !w.InWinPE() {
		return nil, nil
	}
	seen := map[int]bool{}
	var out []int
	err := forEachVolume(func(vol string) error {
		p, err := windows.UTF16PtrFromString(withTrailingBackslash(vol) + `sources\boot.wim`)
		if err != nil {
			return nil
		}
		if _, err := windows.GetFileAttributes(p); err != nil {
			return nil
		}
		devType, n, _, err := storageDeviceNumber(volumeDevicePath(vol))
		if err != nil || devType != fileDeviceDisk || seen[int(n)] {
			return nil
		}
		seen[int(n)] = true
		out = append(out, int(n))
		return nil
	})
	return out, err
}

func openPhysicalDrive(diskNumber int, access uint32) (windows.Handle, error) {
	return openDevice(fmt.Sprintf(`\\.\PhysicalDrive%d`, diskNumber), access)
}

// diskLength is IOCTL_DISK_GET_LENGTH_INFO (GET_LENGTH_INFORMATION
// { LARGE_INTEGER Length }); h needs read access.
func diskLength(h windows.Handle) (int64, error) {
	var length int64
	var n uint32
	if err := windows.DeviceIoControl(h, wingpt.IOCTLDiskGetLengthInfo, nil, 0, (*byte)(unsafe.Pointer(&length)), uint32(unsafe.Sizeof(length)), &n, nil); err != nil {
		return 0, fmt.Errorf("IOCTL_DISK_GET_LENGTH_INFO: %w", err)
	}
	return length, nil
}

func (w *winSystemWindows) DiskInfo(diskNumber int) (WinDiskInfo, error) {
	h, err := openPhysicalDrive(diskNumber, windows.GENERIC_READ)
	if err != nil {
		return WinDiskInfo{}, err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	length, err := diskLength(h)
	if err != nil {
		return WinDiskInfo{}, err
	}
	var n uint32
	geo := make([]byte, 256) // DISK_GEOMETRY_EX is 32 bytes + variable partition/detection data
	if err := windows.DeviceIoControl(h, ioctlDiskGetDriveGeometryEx, nil, 0, &geo[0], uint32(len(geo)), &n, nil); err != nil {
		return WinDiskInfo{}, fmt.Errorf("IOCTL_DISK_GET_DRIVE_GEOMETRY_EX: %w", err)
	}
	if n < 24 {
		return WinDiskInfo{}, fmt.Errorf("IOCTL_DISK_GET_DRIVE_GEOMETRY_EX returned %d bytes", n)
	}
	info := WinDiskInfo{SizeBytes: length, LogicalSectorSize: int(binary.LittleEndian.Uint32(geo[20:24]))}
	// GET_DISK_ATTRIBUTES { ULONG Version; ULONG Reserved1; ULONGLONG
	// Attributes } — DISK_ATTRIBUTE_OFFLINE 0x1, DISK_ATTRIBUTE_READ_ONLY
	// 0x2 (winioctl.h). A device that does not implement the IOCTL (some
	// virtual disks) is treated as online and writable.
	var attrs [2]uint64
	if err := windows.DeviceIoControl(h, wingpt.IOCTLDiskGetDiskAttributes, nil, 0, (*byte)(unsafe.Pointer(&attrs[0])), uint32(unsafe.Sizeof(attrs)), &n, nil); err == nil {
		info.Offline = attrs[1]&0x1 != 0
		info.ReadOnly = attrs[1]&0x2 != 0
	}
	return info, nil
}

// VolumesOnDisk lists diskNumber's volumes with their partition numbers
// (IOCTL_STORAGE_GET_DEVICE_NUMBER on each host volume). GUIDPath is the
// \\?\Volume{GUID}\ form, trailing backslash included (Ruling B1a).
func (w *winSystemWindows) VolumesOnDisk(diskNumber int) ([]WinVolume, error) {
	var out []WinVolume
	err := forEachVolume(func(vol string) error {
		devType, n, part, err := storageDeviceNumber(volumeDevicePath(vol))
		if err != nil || devType != fileDeviceDisk || int(n) != diskNumber {
			return nil // CD-ROMs, spanned volumes and other disks are not ours
		}
		out = append(out, WinVolume{GUIDPath: withTrailingBackslash(vol), DiskNumber: diskNumber, PartitionNumber: int(part), DriveLetter: driveLetterFor(vol)})
		return nil
	})
	return out, err
}

func driveLetterFor(volGUIDPath string) string {
	p, err := windows.UTF16PtrFromString(withTrailingBackslash(volGUIDPath))
	if err != nil {
		return ""
	}
	var buf [256]uint16 // REG_MULTI_SZ-shaped list of every path the volume is mounted at
	var need uint32
	if err := windows.GetVolumePathNamesForVolumeName(p, &buf[0], uint32(len(buf)), &need); err != nil {
		return ""
	}
	for i := 0; i < len(buf) && buf[i] != 0; {
		s := windows.UTF16ToString(buf[i:])
		if len(s) == 3 && s[1] == ':' && s[2] == '\\' {
			return string(s[0])
		}
		i += len(s) + 1
	}
	return ""
}

// openVHDX opens path with the Version2 parameters (the access mask must
// be VIRTUAL_DISK_ACCESS_NONE with Version2).
func openVHDX(path string) (windows.Handle, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	params := openVirtualDiskParametersV2{Version: openVirtualDiskVersion2}
	var h windows.Handle
	r1, _, _ := procOpenVirtualDisk.Call(uintptr(unsafe.Pointer(&virtualStorageTypeVHDX)), uintptr(unsafe.Pointer(p)),
		virtualDiskAccessNone, openVirtualDiskFlagNone, uintptr(unsafe.Pointer(&params)), uintptr(unsafe.Pointer(&h)))
	if r1 != 0 {
		return 0, fmt.Errorf("OpenVirtualDisk %s: %w", path, windows.Errno(r1))
	}
	return h, nil
}

// CreateVHDX creates a dynamic VHDX (32 MiB blocks) whose logical sector
// size matches the source disk's (512 or 4096; anything else → 512).
func (w *winSystemWindows) CreateVHDX(path string, sizeBytes int64, logicalSectorSize int) error {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	sector := uint32(logicalSectorSize)
	if sector != 4096 {
		sector = 512 // VHDX supports 512 and 4096 logical sectors only
	}
	params := createVirtualDiskParametersV2{
		Version: createVirtualDiskVersion2, MaximumSize: uint64(sizeBytes),
		BlockSizeInBytes: vhdxBlockSizeBytes, SectorSizeInBytes: sector, PhysicalSectorSizeInBytes: 4096,
	}
	var h windows.Handle
	r1, _, _ := procCreateVirtualDisk.Call(
		uintptr(unsafe.Pointer(&virtualStorageTypeVHDX)), uintptr(unsafe.Pointer(p)),
		virtualDiskAccessNone, 0, createVirtualDiskFlagNone, 0,
		uintptr(unsafe.Pointer(&params)), 0, uintptr(unsafe.Pointer(&h)))
	if r1 != 0 {
		return fmt.Errorf("CreateVirtualDisk %s: %w", path, windows.Errno(r1))
	}
	return windows.CloseHandle(h) // AttachVHDX opens its own handle
}

// AttachVHDX attaches without PERMANENT_LIFETIME and with NO_DRIVE_LETTER,
// keeping the virtual-disk handle open (the attach lives exactly as long as
// it) until detach / DetachVHDXByPath closes it.
func (w *winSystemWindows) AttachVHDX(path string) (int, func() error, error) {
	w.mu.Lock()
	_, already := w.vhdxHandles[path]
	w.mu.Unlock()
	if already {
		return 0, nil, fmt.Errorf("VHDX %s is already attached by this process", path)
	}
	h, err := openVHDX(path)
	if err != nil {
		return 0, nil, err
	}
	params := attachVirtualDiskParametersV2{Version: attachVirtualDiskVersion2}
	r1, _, _ := procAttachVirtualDisk.Call(uintptr(h), 0, attachFlagNoDriveLetter, 0, uintptr(unsafe.Pointer(&params)), 0)
	if r1 != 0 {
		_ = windows.CloseHandle(h)
		return 0, nil, fmt.Errorf("AttachVirtualDisk %s: %w", path, windows.Errno(r1))
	}
	phys, err := physicalPath(h)
	if err != nil {
		_ = windows.CloseHandle(h) // non-permanent attach: closing the handle detaches
		return 0, nil, fmt.Errorf("GetVirtualDiskPhysicalPath %s: %w", path, err)
	}
	n, err := physicalDriveNumber(phys)
	if err != nil {
		_ = windows.CloseHandle(h)
		return 0, nil, err
	}
	w.mu.Lock()
	w.vhdxHandles[path] = h
	w.mu.Unlock()
	return n, func() error { _, err := w.DetachVHDXByPath(path); return err }, nil
}

// physicalPath: GetVirtualDiskPhysicalPath(handle, PULONG
// DiskPathSizeInBytes, PWSTR DiskPath) — the size is in BYTES.
func physicalPath(h windows.Handle) (string, error) {
	var buf [windows.MAX_PATH]uint16
	size := uint32(len(buf) * 2)
	r1, _, _ := procGetVirtualDiskPhysicalPath.Call(uintptr(h), uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&buf[0])))
	if r1 != 0 {
		return "", windows.Errno(r1)
	}
	return windows.UTF16ToString(buf[:]), nil
}

// DetachVHDXByPath: the handle this process holds when it attached the
// VHDX; otherwise open the file and detach it only if it is attached
// (GetVirtualDiskPhysicalPath fails on a detached disk). No file → (false,
// nil).
func (w *winSystemWindows) DetachVHDXByPath(path string) (bool, error) {
	w.mu.Lock()
	h, ours := w.vhdxHandles[path]
	delete(w.vhdxHandles, path)
	w.mu.Unlock()
	if !ours {
		if _, err := os.Stat(path); err != nil {
			return false, nil
		}
		var err error
		if h, err = openVHDX(path); err != nil {
			return false, err
		}
		if _, err := physicalPath(h); err != nil {
			_ = windows.CloseHandle(h)
			return false, nil // not attached
		}
	}
	r1, _, _ := procDetachVirtualDisk.Call(uintptr(h), detachVirtualDiskFlagNone, 0)
	closeErr := windows.CloseHandle(h)
	if r1 != 0 {
		return false, fmt.Errorf("DetachVirtualDisk %s: %w", path, windows.Errno(r1))
	}
	return true, closeErr
}

// WipeDisk locks and dismounts every volume on the disk and keeps those
// handles (and so the locks) open across DeleteLayout and the zeroing, so
// nothing can remount a volume in between; they close on return.
func (w *winSystemWindows) WipeDisk(_ context.Context, diskNumber int) error {
	vols, err := w.VolumesOnDisk(diskNumber)
	if err != nil {
		return err
	}
	var locked []windows.Handle
	defer func() {
		for _, h := range locked {
			_ = windows.CloseHandle(h)
		}
	}()
	for _, v := range vols {
		h, err := lockAndDismountVolume(v.GUIDPath)
		if err != nil {
			return fmt.Errorf("lock/dismount %s: %w", v.GUIDPath, err)
		}
		locked = append(locked, h)
	}
	if err := wingpt.DeleteLayout(diskNumber); err != nil {
		return err
	}
	return zeroFirstAndLastMiB(diskNumber)
}

// lockAndDismountVolume: FSCTL_LOCK_VOLUME then FSCTL_DISMOUNT_VOLUME,
// returning the open handle that holds the lock (the caller closes it). A
// lock refused because something (an indexer, AV) still has a file open is
// retried briefly; if it is still refused the volume is force-dismounted —
// which invalidates those handles — and locked again.
func lockAndDismountVolume(volGUIDPath string) (windows.Handle, error) {
	h, err := openDevice(volumeDevicePath(volGUIDPath), windows.GENERIC_READ|windows.GENERIC_WRITE)
	if err != nil {
		return 0, err
	}
	var n uint32
	lock := func() error { return windows.DeviceIoControl(h, wingpt.FSCTLLockVolume, nil, 0, nil, 0, &n, nil) }
	dismount := func() error { return windows.DeviceIoControl(h, wingpt.FSCTLDismountVolume, nil, 0, nil, 0, &n, nil) }
	lockErr := lock()
	for i := 0; lockErr != nil && i < volumeLockRetries; i++ {
		time.Sleep(volumeLockRetryDelay)
		lockErr = lock()
	}
	if lockErr != nil {
		if err := dismount(); err != nil {
			_ = windows.CloseHandle(h)
			return 0, fmt.Errorf("FSCTL_LOCK_VOLUME: %w; forced FSCTL_DISMOUNT_VOLUME: %v", lockErr, err)
		}
		if err := lock(); err != nil {
			_ = windows.CloseHandle(h)
			return 0, fmt.Errorf("FSCTL_LOCK_VOLUME after forced dismount: %w", err)
		}
	}
	if err := dismount(); err != nil {
		_ = windows.CloseHandle(h)
		return 0, fmt.Errorf("FSCTL_DISMOUNT_VOLUME: %w", err)
	}
	return h, nil
}

const (
	volumeLockRetries    = 20
	volumeLockRetryDelay = 100 * time.Millisecond
)

// zeroFirstAndLastMiB clears the protective MBR + primary GPT and the
// backup GPT. The disk length is a multiple of the logical sector size, and
// so is MiB, so length-MiB is sector-aligned as raw disk I/O requires.
func zeroFirstAndLastMiB(diskNumber int) error {
	h, err := openPhysicalDrive(diskNumber, windows.GENERIC_READ|windows.GENERIC_WRITE)
	if err != nil {
		return err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	length, err := diskLength(h)
	if err != nil {
		return err
	}
	zero := make([]byte, MiB)
	var written uint32
	if err := windows.WriteFile(h, zero, &written, nil); err != nil {
		return fmt.Errorf("zero first MiB of disk %d: %w", diskNumber, err)
	}
	if length > 2*MiB {
		if _, err := windows.Seek(h, length-MiB, 0); err != nil { // 64-bit offset (SetFilePointerEx)
			return fmt.Errorf("seek to last MiB of disk %d: %w", diskNumber, err)
		}
		if err := windows.WriteFile(h, zero, &written, nil); err != nil {
			return fmt.Errorf("zero last MiB of disk %d: %w", diskNumber, err)
		}
	}
	return nil
}

// WriteGPT: IOCTL_DISK_CREATE_DISK (GPT, diskGUID) → SET_DRIVE_LAYOUT_EX
// with every partition's type/partition GUID, name and attributes exactly
// as given (wingpt.Partition, no conversion) → UPDATE_PROPERTIES so the
// new volumes appear. Relies on wingpt.WriteLayout copying the usable
// range from the layout CREATE_DISK just wrote, so it must follow it.
func (w *winSystemWindows) WriteGPT(diskNumber int, diskGUID string, parts []WinGPTPartition) error {
	if len(parts) == 0 {
		return errors.New("WriteGPT: no partitions to write")
	}
	if err := wingpt.CreateDisk(diskNumber, diskGUID); err != nil {
		return err
	}
	if err := wingpt.WriteLayout(diskNumber, wingpt.Layout{DiskGUID: diskGUID, Partitions: parts}); err != nil {
		return err
	}
	return wingpt.UpdateProperties(diskNumber)
}

func (w *winSystemWindows) ReadGPT(diskNumber int) (string, []WinGPTPartition, error) {
	l, err := wingpt.ReadLayout(diskNumber)
	if err != nil {
		return "", nil, err
	}
	return l.DiskGUID, l.Partitions, nil
}

func (w *winSystemWindows) SetPartitionAttributes(diskNumber, number int, attrs uint64) error {
	return wingpt.SetPartitionAttributes(diskNumber, number, attrs)
}

// WaitForVolumes polls VolumesOnDisk until at least want volumes exist
// (each carrying its partition number) or partitionDeviceWaitTimeout.
func (w *winSystemWindows) WaitForVolumes(ctx context.Context, diskNumber int, want int) ([]WinVolume, error) {
	deadline := time.Now().Add(partitionDeviceWaitTimeout)
	for {
		vols, err := w.VolumesOnDisk(diskNumber)
		if err != nil {
			return nil, err
		}
		if len(vols) >= want {
			return vols, nil
		}
		if time.Now().After(deadline) {
			return vols, fmt.Errorf("only %d of %d expected volumes appeared on disk %d within %s", len(vols), want, diskNumber, partitionDeviceWaitTimeout)
		}
		select {
		case <-ctx.Done():
			return vols, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (w *winSystemWindows) Format(ctx context.Context, volumeGUIDPath, filesystem, label string) error {
	out, err := winRunWithRetry(ctx, w, "format.com", formatComArgs(volumeGUIDPath, filesystem, label)...)
	if err != nil {
		return fmt.Errorf("format.com %s: %s: %w", volumeGUIDPath, strings.TrimSpace(string(out)), err)
	}
	return nil
}

// MountVolume: SetVolumeMountPointW(dir\, \\?\Volume{GUID}\) — both
// arguments carry a trailing backslash; dir must be an empty directory and
// is created when it does not exist yet. A stale mount point left at dir by
// a crashed run is removed first.
func (w *winSystemWindows) MountVolume(volumeGUIDPath, dir string) error {
	dirP, err := windows.UTF16PtrFromString(withTrailingBackslash(dir))
	if err != nil {
		return err
	}
	volP, err := windows.UTF16PtrFromString(withTrailingBackslash(volumeGUIDPath))
	if err != nil {
		return err
	}
	_ = windows.DeleteVolumeMountPoint(dirP) // not a mount point / absent → harmless error
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := windows.SetVolumeMountPoint(dirP, volP); err != nil {
		return fmt.Errorf("SetVolumeMountPointW %s -> %s: %w", dir, volumeGUIDPath, err)
	}
	return nil
}

func (w *winSystemWindows) UnmountVolume(dir string) error {
	dirP, err := windows.UTF16PtrFromString(withTrailingBackslash(dir))
	if err != nil {
		return err
	}
	if err := windows.DeleteVolumeMountPoint(dirP); err != nil {
		return fmt.Errorf("DeleteVolumeMountPointW %s: %w", dir, err)
	}
	return nil
}

func (w *winSystemWindows) AssignLetter(volumeGUIDPath string) (string, func() error, error) {
	volP, err := windows.UTF16PtrFromString(withTrailingBackslash(volumeGUIDPath))
	if err != nil {
		return "", nil, err
	}
	for _, c := range letterCandidates() {
		letter := string(c)
		dirP, err := windows.UTF16PtrFromString(letter + `:\`)
		if err != nil {
			return "", nil, err
		}
		if windows.SetVolumeMountPoint(dirP, volP) == nil {
			return letter, func() error { return w.UnmountVolume(letter + ":") }, nil
		}
		// in use (or not assignable): try the next letter
	}
	return "", nil, errors.New("no free drive letter Z..D available for the ESP")
}

func (w *winSystemWindows) FlushVolume(volumeGUIDPath string) error {
	h, err := openDevice(volumeDevicePath(volumeGUIDPath), windows.GENERIC_READ|windows.GENERIC_WRITE)
	if err != nil {
		return err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	if err := windows.FlushFileBuffers(h); err != nil {
		return fmt.Errorf("FlushFileBuffers %s: %w", volumeGUIDPath, err)
	}
	return nil
}

// FreeSpace answers for the nearest existing ancestor of dir (the output
// directory of a vhdx: target may not exist yet).
func (w *winSystemWindows) FreeSpace(dir string) (int64, error) {
	for d := dir; ; d = filepath.Dir(d) {
		if fi, err := os.Stat(d); err == nil && fi.IsDir() {
			p, err := windows.UTF16PtrFromString(d)
			if err != nil {
				return 0, err
			}
			var free, total, totalFree uint64
			if err := windows.GetDiskFreeSpaceEx(p, &free, &total, &totalFree); err != nil {
				return 0, fmt.Errorf("GetDiskFreeSpaceExW %s: %w", d, err)
			}
			return int64(free), nil
		}
		if filepath.Dir(d) == d {
			return 0, fmt.Errorf("no existing directory above %s", dir)
		}
	}
}

// LoadHive holds SeBackup+SeRestore (backup.AcquireHivePrivileges) from
// before RegLoadKeyW until after the returned handle's Close has run
// RegUnLoadKeyW (controller ruling B2 — winhive does no privilege work).
func (w *winSystemWindows) LoadHive(hiveFile, mountName string) (winhive.Handle, error) {
	release, err := backup.AcquireHivePrivileges()
	if err != nil {
		return nil, fmt.Errorf("load hive %s: %w", hiveFile, err)
	}
	h, err := winhive.Load(hiveFile, mountName)
	if err != nil {
		release()
		return nil, err
	}
	return &hiveWithRelease{Handle: h, release: release}, nil
}

// UnloadStaleHives holds SeBackup+SeRestore around winhive.UnloadStale's
// RegUnLoadKeyW sweep.
func (w *winSystemWindows) UnloadStaleHives(prefix string) (int, error) {
	release, err := backup.AcquireHivePrivileges()
	if err != nil {
		return 0, fmt.Errorf("unload stale hives: %w", err)
	}
	defer release()
	return winhive.UnloadStale(prefix)
}

// HasWindowsTree reports whether the volume holds
// \Windows\System32\config\SYSTEM. A RAW (unformatted) volume has no tree;
// any other failure (a locked BitLocker volume, access denied) is an error
// so preflight fails closed instead of wiping a Windows install it could
// not inspect.
func (w *winSystemWindows) HasWindowsTree(volumeGUIDPath string) (bool, error) {
	p, err := windows.UTF16PtrFromString(withTrailingBackslash(volumeGUIDPath) + `Windows\System32\config\SYSTEM`)
	if err != nil {
		return false, err
	}
	if _, err := windows.GetFileAttributes(p); err != nil {
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) || errors.Is(err, errUnrecognizedVolume) {
			return false, nil
		}
		return false, fmt.Errorf("inspect %s: %w", volumeGUIDPath, err)
	}
	return true, nil
}
