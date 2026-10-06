//go:build windows

package windisks

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/breeze-rmm/agent/internal/backup/wingpt"
)

const (
	maxDisks                  = 64
	ioctlStorageQueryProperty = 0x2D1400
	queryBufferSize           = 1024
)

// storagePropertyQuery mirrors STORAGE_PROPERTY_QUERY with no additional
// parameters: PropertyId 0 (StorageDeviceProperty), QueryType 0
// (PropertyStandardQuery), padded to the 12-byte layout.
type storagePropertyQuery struct {
	PropertyID uint32
	QueryType  uint32
	Extra      [4]byte
}

// List probes \\.\PhysicalDrive0..63 and returns every disk present. Absent
// drive numbers are skipped; any other error is returned.
func List() ([]Disk, error) {
	var disks []Disk
	for n := 0; n < maxDisks; n++ {
		d, present, err := probe(n)
		if err != nil {
			return nil, err
		}
		if present {
			disks = append(disks, d)
		}
	}
	return disks, nil
}

// skippable reports whether err wraps a Win32 errno that skippableProbeErr
// classifies as "no usable disk here".
func skippable(err error) bool {
	var errno windows.Errno
	return errors.As(err, &errno) && skippableProbeErr(uint32(errno))
}

func openDrive(path string, access uint32) (windows.Handle, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	return windows.CreateFile(p, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
}

// probe inspects one drive; the deferred closes are scoped to this call so
// no handle outlives its loop iteration.
func probe(n int) (Disk, bool, error) {
	path := fmt.Sprintf(`\\.\PhysicalDrive%d`, n)

	// Access 0 (query-only) so the open succeeds even for drives we may not
	// read, and for empty removable slots that answer property queries.
	h, err := openDrive(path, 0)
	if err != nil {
		if skippable(err) {
			return Disk{}, false, nil
		}
		return Disk{}, false, fmt.Errorf("windisks: open %s: %w", path, err)
	}
	defer func() { _ = windows.CloseHandle(h) }()

	q := storagePropertyQuery{}
	buf := make([]byte, queryBufferSize)
	var returned uint32
	if err := windows.DeviceIoControl(h, ioctlStorageQueryProperty,
		(*byte)(unsafe.Pointer(&q)), uint32(unsafe.Sizeof(q)),
		&buf[0], uint32(len(buf)), &returned, nil); err != nil {
		if skippable(err) {
			return Disk{}, false, nil
		}
		return Disk{}, false, fmt.Errorf("windisks: IOCTL_STORAGE_QUERY_PROPERTY %s: %w", path, err)
	}
	model, serial, bus, removable, err := DecodeDeviceDescriptor(buf[:returned])
	if err != nil {
		return Disk{}, false, fmt.Errorf("windisks: %s: %w", path, err)
	}

	size, err := lengthInfo(path)
	if err != nil {
		if skippable(err) {
			return Disk{}, false, nil
		}
		return Disk{}, false, err
	}
	return Disk{Number: n, Path: path, Model: model, Serial: serial, SizeBytes: size, BusType: bus, Removable: removable}, true, nil
}

func lengthInfo(path string) (int64, error) {
	h, err := openDrive(path, windows.GENERIC_READ)
	if err != nil {
		return 0, fmt.Errorf("windisks: open %s for read: %w", path, err)
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var length int64 // GET_LENGTH_INFORMATION.Length (LARGE_INTEGER)
	var returned uint32
	if err := windows.DeviceIoControl(h, wingpt.IOCTLDiskGetLengthInfo, nil, 0,
		(*byte)(unsafe.Pointer(&length)), uint32(unsafe.Sizeof(length)), &returned, nil); err != nil {
		return 0, fmt.Errorf("windisks: IOCTL_DISK_GET_LENGTH_INFO %s: %w", path, err)
	}
	return length, nil
}
