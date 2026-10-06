// Package windisks lists physical disks on Windows with
// IOCTL_STORAGE_QUERY_PROPERTY + IOCTL_DISK_GET_LENGTH_INFO, for the
// recovery console on WinPE, where PowerShell's Get-Disk (the layout
// collector's path) is not available.
package windisks

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
)

type Disk struct {
	Number    int
	Path      string
	Model     string
	Serial    string
	SizeBytes int64
	BusType   uint32
	Removable bool
}

var ErrUnsupported = errors.New("windisks: not supported on this platform")

const (
	busUSB           = 7
	busSD            = 12
	busMMC           = 13
	descriptorHeader = 36
)

// Win32 error numbers (untagged so the classification is testable everywhere).
const (
	errFileNotFound      = 2
	errPathNotFound      = 3
	errNotReady          = 21
	errNoMediaInDrive    = 1112
	errUnrecognizedMedia = 1785
)

// skippableProbeErr reports whether a per-disk Win32 error means "this slot
// has no usable disk" (absent drive number, or an empty card reader / USB slot
// with no media). Such a drive is never a valid restore target, so List skips
// it; every other error is fatal so real faults fail loudly.
func skippableProbeErr(errno uint32) bool {
	switch errno {
	case errFileNotFound, errPathNotFound, errNotReady, errNoMediaInDrive, errUnrecognizedMedia:
		return true
	}
	return false
}

func DecodeDeviceDescriptor(b []byte) (model, serial string, busType uint32, removable bool, err error) {
	if len(b) < descriptorHeader {
		return "", "", 0, false, fmt.Errorf("storage device descriptor is %d bytes, need %d", len(b), descriptorHeader)
	}
	str := func(off int) (string, error) {
		o := binary.LittleEndian.Uint32(b[off:])
		if o == 0 {
			return "", nil
		}
		if int(o) >= len(b) {
			return "", fmt.Errorf("descriptor string offset %d past end (%d)", o, len(b))
		}
		end := int(o)
		for end < len(b) && b[end] != 0 {
			end++
		}
		return strings.TrimSpace(string(b[o:end])), nil
	}
	vendor, err := str(12)
	if err != nil {
		return "", "", 0, false, err
	}
	product, err := str(16)
	if err != nil {
		return "", "", 0, false, err
	}
	serial, err = str(24)
	if err != nil {
		return "", "", 0, false, err
	}
	busType = binary.LittleEndian.Uint32(b[28:])
	removable = b[10] != 0 || busType == busUSB || busType == busSD || busType == busMMC
	model = strings.TrimSpace(strings.TrimSpace(vendor) + " " + product)
	return model, serial, busType, removable, nil
}
