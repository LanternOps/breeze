//go:build darwin

package securefs

import (
	"encoding/binary"
	"unsafe"

	"golang.org/x/sys/unix"
)

// attrList mirrors struct attrlist for fgetattrlist(2).
type attrList struct {
	bitmapCount uint16
	reserved    uint16
	commonAttr  uint32
	volAttr     uint32
	dirAttr     uint32
	fileAttr    uint32
	forkAttr    uint32
}

const attrCmnReturnedAttrs = 0x80000000

// dirHasExtendedACL reports whether the directory carries an extended access
// list (what `ls -le` shows as "+"). fgetattrlist returns the
// ATTR_CMN_EXTENDED_SECURITY bit in its returned-attributes set only when
// one exists.
func dirHasExtendedACL(fd int) (bool, error) {
	request := attrList{bitmapCount: 5, commonAttr: unix.ATTR_CMN_EXTENDED_SECURITY | attrCmnReturnedAttrs}
	buf := make([]byte, 4096)
	_, _, errno := unix.Syscall6(unix.SYS_FGETATTRLIST, uintptr(fd), uintptr(unsafe.Pointer(&request)),
		uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), 0, 0)
	if errno != 0 {
		return false, errno
	}
	// Layout: u32 total length, then the returned attribute_set_t whose first
	// u32 is the common attributes actually returned.
	returned := binary.LittleEndian.Uint32(buf[4:8])
	return returned&unix.ATTR_CMN_EXTENDED_SECURITY != 0, nil
}
