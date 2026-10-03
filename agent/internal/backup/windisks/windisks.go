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
