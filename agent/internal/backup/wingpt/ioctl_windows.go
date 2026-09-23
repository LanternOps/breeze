//go:build windows

package wingpt

import (
	"fmt"

	"golang.org/x/sys/windows"
)

func openPhysicalDrive(diskNumber int, access uint32) (windows.Handle, error) {
	path := fmt.Sprintf(`\\.\PhysicalDrive%d`, diskNumber)
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, fmt.Errorf("wingpt: encode %s: %w", path, err)
	}
	h, err := windows.CreateFile(p, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return 0, fmt.Errorf("wingpt: open %s: %w", path, err)
	}
	return h, nil
}

// ReadLayout reads diskNumber's current GPT partition table via
// IOCTL_DISK_GET_DRIVE_LAYOUT_EX. The output buffer has no fixed maximum
// size (one 144-byte entry per partition), so this grows the buffer and
// retries on ERROR_INSUFFICIENT_BUFFER/ERROR_MORE_DATA exactly like the
// two-call GetFileSecurityW pattern Task 4 uses for the same reason — bounded
// by nextLayoutBufferSize's 128-partition cap.
func ReadLayout(diskNumber int) (Layout, error) {
	h, err := openPhysicalDrive(diskNumber, windows.GENERIC_READ)
	if err != nil {
		return Layout{}, err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	raw, err := readRawLayout(h, diskNumber)
	if err != nil {
		return Layout{}, err
	}
	return DecodeDriveLayoutEx(raw)
}

func readRawLayout(h windows.Handle, diskNumber int) ([]byte, error) {
	bufLen := initialLayoutBufferSize
	for {
		buf := make([]byte, bufLen)
		var returned uint32
		ioErr := windows.DeviceIoControl(h, IOCTLDiskGetDriveLayoutEx, nil, 0, &buf[0], bufLen, &returned, nil)
		if ioErr == nil {
			return buf[:returned], nil
		}
		if ioErr == windows.ERROR_INSUFFICIENT_BUFFER || ioErr == windows.ERROR_MORE_DATA {
			next, ok := nextLayoutBufferSize(bufLen)
			if !ok {
				return nil, fmt.Errorf("wingpt: IOCTL_DISK_GET_DRIVE_LAYOUT_EX on disk %d: layout does not fit a %d-byte buffer (%d partitions): %w", diskNumber, bufLen, maxLayoutPartitions, ioErr)
			}
			bufLen = next
			continue
		}
		return nil, fmt.Errorf("wingpt: IOCTL_DISK_GET_DRIVE_LAYOUT_EX on disk %d: %w", diskNumber, ioErr)
	}
}

// WriteLayout writes l as diskNumber's GPT partition table via
// IOCTL_DISK_SET_DRIVE_LAYOUT_EX. The disk must already have a GPT
// CREATE_DISK issued (see CreateDisk) — SET_DRIVE_LAYOUT_EX on a disk with
// no partition style set fails.
func WriteLayout(diskNumber int, l Layout) error {
	h, err := openPhysicalDrive(diskNumber, windows.GENERIC_READ|windows.GENERIC_WRITE)
	if err != nil {
		return err
	}
	defer func() { _ = windows.CloseHandle(h) }()

	buf, err := EncodeDriveLayoutEx(l)
	if err != nil {
		return err
	}
	current, err := readRawLayout(h, diskNumber)
	if err != nil {
		return err
	}
	if err := CopyUsableRange(buf, current); err != nil {
		return err
	}
	var returned uint32
	if err := windows.DeviceIoControl(h, IOCTLDiskSetDriveLayoutEx, &buf[0], uint32(len(buf)), nil, 0, &returned, nil); err != nil {
		return fmt.Errorf("wingpt: IOCTL_DISK_SET_DRIVE_LAYOUT_EX on disk %d: %w", diskNumber, err)
	}
	return nil
}

// CreateDisk initialises diskNumber as an empty GPT disk with diskGUID
// (CREATE_DISK layout: see EncodeCreateDiskGPT and TestEncodeCreateDiskGPT).
func CreateDisk(diskNumber int, diskGUID string) error {
	buf, err := EncodeCreateDiskGPT(diskGUID)
	if err != nil {
		return err
	}
	h, err := openPhysicalDrive(diskNumber, windows.GENERIC_READ|windows.GENERIC_WRITE)
	if err != nil {
		return err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var returned uint32
	if err := windows.DeviceIoControl(h, IOCTLDiskCreateDisk, &buf[0], uint32(len(buf)), nil, 0, &returned, nil); err != nil {
		return fmt.Errorf("wingpt: IOCTL_DISK_CREATE_DISK on disk %d: %w", diskNumber, err)
	}
	return nil
}

// DeleteLayout wipes diskNumber's partition table via
// IOCTL_DISK_DELETE_DRIVE_LAYOUT (no input/output buffer).
func DeleteLayout(diskNumber int) error {
	h, err := openPhysicalDrive(diskNumber, windows.GENERIC_READ|windows.GENERIC_WRITE)
	if err != nil {
		return err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var returned uint32
	if err := windows.DeviceIoControl(h, IOCTLDiskDeleteDriveLayout, nil, 0, nil, 0, &returned, nil); err != nil {
		return fmt.Errorf("wingpt: IOCTL_DISK_DELETE_DRIVE_LAYOUT on disk %d: %w", diskNumber, err)
	}
	return nil
}

// UpdateProperties tells Windows to re-read diskNumber's partition table
// from the media via IOCTL_DISK_UPDATE_PROPERTIES (no input/output buffer)
// — required after WriteLayout/DeleteLayout so subsequent volume enumeration
// (FindFirstVolumeW etc., W06b's WinSystem.WaitForVolumes) sees the change.
func UpdateProperties(diskNumber int) error {
	h, err := openPhysicalDrive(diskNumber, windows.GENERIC_READ|windows.GENERIC_WRITE)
	if err != nil {
		return err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var returned uint32
	if err := windows.DeviceIoControl(h, IOCTLDiskUpdateProperties, nil, 0, nil, 0, &returned, nil); err != nil {
		return fmt.Errorf("wingpt: IOCTL_DISK_UPDATE_PROPERTIES on disk %d: %w", diskNumber, err)
	}
	return nil
}

// SetPartitionAttributes rewrites one partition's GPT attributes in place:
// read the current layout, patch the matching entry, write the whole table
// back (SET_DRIVE_LAYOUT_EX has no single-partition-attribute IOCTL) and
// re-read the properties so the change is visible immediately. This is what
// winValidate (W06b) uses to clear the "no drive letter" attribute bit on
// root/data partitions after boot, and what Provision uses to set it during
// initial layout writes indirectly (via WriteLayout, not this function).
func SetPartitionAttributes(diskNumber, number int, attrs uint64) error {
	l, err := ReadLayout(diskNumber)
	if err != nil {
		return err
	}
	found := false
	for i := range l.Partitions {
		if l.Partitions[i].Number == number {
			l.Partitions[i].Attributes = attrs
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("wingpt: disk %d has no partition numbered %d", diskNumber, number)
	}
	if err := WriteLayout(diskNumber, l); err != nil {
		return err
	}
	return UpdateProperties(diskNumber)
}
