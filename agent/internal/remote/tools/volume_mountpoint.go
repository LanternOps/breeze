package tools

import (
	"encoding/binary"
	"regexp"
	"unicode/utf16"
)

// A Windows volume can be mounted at a folder (a volume mount point): the
// folder is a reparse point with the mount-point tag whose target is a
// volume root, \??\Volume{GUID}\. A junction carries the same tag but targets
// an ordinary folder. Scans accept the first as a root, as the root of that
// volume, and refuse the second, like any other link.

const reparseTagMountPoint = 0xA0000003 // IO_REPARSE_TAG_MOUNT_POINT

var volumeRootTarget = regexp.MustCompile(`^\\\?\?\\Volume\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}\\$`)

// isVolumeRootTarget reports whether a mount-point substitute name is a
// volume root rather than a folder.
func isVolumeRootTarget(substitute string) bool {
	return volumeRootTarget.MatchString(substitute)
}

// mountPointSubstituteName returns the substitute name of a reparse buffer
// with the mount-point tag (REPARSE_DATA_BUFFER, MountPointReparseBuffer).
// ok is false for another tag or a malformed buffer.
func mountPointSubstituteName(buf []byte) (string, bool) {
	const fixed = 16 // tag, data length, reserved, then four uint16 offsets/lengths
	if len(buf) < fixed || binary.LittleEndian.Uint32(buf[0:]) != reparseTagMountPoint {
		return "", false
	}
	off := int(binary.LittleEndian.Uint16(buf[8:]))
	n := int(binary.LittleEndian.Uint16(buf[10:]))
	names := buf[fixed:]
	if n%2 != 0 || off < 0 || off+n > len(names) {
		return "", false
	}
	u := make([]uint16, n/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(names[off+2*i:])
	}
	return string(utf16.Decode(u)), true
}
