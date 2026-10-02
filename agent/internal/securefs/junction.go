package securefs

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"
)

// ErrJunctionUnsupported is returned by InstallJunction on a host that has no
// NTFS junctions (anything but Windows). A Windows snapshot can be restored on
// another OS; its junctions are then reported, not recreated.
var ErrJunctionUnsupported = errors.New("junctions can only be recreated on Windows")

// ioReparseTagMountPoint is IO_REPARSE_TAG_MOUNT_POINT, the tag a junction
// carries. Spelled out so the buffer layout builds and is tested everywhere.
const ioReparseTagMountPoint uint32 = 0xA0000003

// maxReparseDataBufferSize is MAXIMUM_REPARSE_DATA_BUFFER_SIZE (16 KiB).
const maxReparseDataBufferSize = 16 * 1024

// ValidJunctionTarget reports whether target is a path this package will point
// a junction at: an ordinary drive-letter absolute path ("C:\x\y", or the
// volume root "C:\") with backslash separators and no empty, ".", ".." or
// stream (':') component. The target is read from a backup manifest, which is
// attacker-influenced input, so every other shape (UNC, "\\?\", "\??\",
// volume GUID paths, relative paths) is refused rather than interpreted.
func ValidJunctionTarget(target string) error {
	if len(target) < 3 || !isDriveLetter(target[0]) || target[1] != ':' || target[2] != '\\' {
		return fmt.Errorf("junction target %q is not a drive-letter absolute path", target)
	}
	if strings.ContainsAny(target, "/\x00") {
		return fmt.Errorf("junction target %q contains a forward slash or NUL", target)
	}
	rest := target[3:]
	if rest == "" {
		return nil // the volume root
	}
	for _, component := range strings.Split(rest, `\`) {
		switch {
		case component == "":
			return fmt.Errorf("junction target %q has an empty path component", target)
		case component == "." || component == "..":
			return fmt.Errorf("junction target %q has a relative component %q", target, component)
		case strings.Contains(component, ":"):
			return fmt.Errorf("junction target %q has a stream separator in %q", target, component)
		}
	}
	return nil
}

func isDriveLetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// JunctionReparseBuffer lays out the REPARSE_DATA_BUFFER that
// FSCTL_SET_REPARSE_POINT takes to turn an empty directory into a junction to
// target: the 8-byte header (tag, data length, reserved), the
// MountPointReparseBuffer offset/length fields, then the substitute name
// ("\??\C:\x") and the print name ("C:\x"), each NUL-terminated with the
// terminator excluded from its length, which is how mklink /J writes them.
//
// Split out from the DeviceIoControl call so the layout can be asserted on any
// platform and round-tripped through the backup collector's parser.
func JunctionReparseBuffer(target string) ([]byte, error) {
	if err := ValidJunctionTarget(target); err != nil {
		return nil, err
	}
	substitute := utf16.Encode([]rune(`\??\` + target))
	print := utf16.Encode([]rune(target))
	subBytes, printBytes := 2*len(substitute), 2*len(print)
	pathBytes := subBytes + 2 + printBytes + 2
	const headerLen, mountHeaderLen = 8, 8
	total := headerLen + mountHeaderLen + pathBytes
	if total > maxReparseDataBufferSize || mountHeaderLen+pathBytes > 0xFFFF {
		return nil, fmt.Errorf("junction target is too long for a reparse point (%d bytes)", total)
	}
	buf := make([]byte, total)
	binary.LittleEndian.PutUint32(buf[0:], ioReparseTagMountPoint)
	binary.LittleEndian.PutUint16(buf[4:], uint16(mountHeaderLen+pathBytes))
	binary.LittleEndian.PutUint16(buf[8:], 0)                   // SubstituteNameOffset
	binary.LittleEndian.PutUint16(buf[10:], uint16(subBytes))   // SubstituteNameLength
	binary.LittleEndian.PutUint16(buf[12:], uint16(subBytes+2)) // PrintNameOffset
	binary.LittleEndian.PutUint16(buf[14:], uint16(printBytes)) // PrintNameLength
	path := buf[headerLen+mountHeaderLen:]
	for i, c := range substitute {
		binary.LittleEndian.PutUint16(path[2*i:], c)
	}
	for i, c := range print {
		binary.LittleEndian.PutUint16(path[subBytes+2+2*i:], c)
	}
	return buf, nil
}

// junctionTargetFromBuffer is JunctionReparseBuffer's inverse for an existing
// IO_REPARSE_TAG_MOUNT_POINT buffer: the substitute name with its "\??\"
// prefix removed, so it compares against the target InstallJunction was given.
// ok is false for any other tag or a malformed buffer.
func junctionTargetFromBuffer(buf []byte) (string, bool) {
	const fixed = 16
	if len(buf) < fixed || binary.LittleEndian.Uint32(buf[0:]) != ioReparseTagMountPoint {
		return "", false
	}
	off := int(binary.LittleEndian.Uint16(buf[8:]))
	n := int(binary.LittleEndian.Uint16(buf[10:]))
	path := buf[fixed:]
	if n%2 != 0 || off+n > len(path) {
		return "", false
	}
	u := make([]uint16, n/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(path[off+2*i:])
	}
	return strings.TrimPrefix(string(utf16.Decode(u)), `\??\`), true
}

// trimJunctionTarget drops one trailing separator from a non-root target, so
// `C:\x\` and `C:\x` compare equal; a volume root keeps its separator.
func trimJunctionTarget(target string) string {
	if len(target) > 3 {
		return strings.TrimSuffix(target, `\`)
	}
	return target
}

// InstallJunction recreates a directory junction to target beneath base,
// relative to the pinned parent directory, never by pathname: no ancestor can
// be traversed as a link, exactly as for InstallSymlink.
//
// Resume semantics: a junction that already points at target is left alone.
// Anything else at that name (a junction to somewhere else, a symlink, a real
// directory or file) is refused, never replaced: it may be an operator's.
//
// winAttrs are the junction's own preserved Windows attributes (the legacy
// profile junctions are Hidden and System). The returned warnings describe
// attributes that could not be applied to a junction that WAS created.
//
// On any host but Windows it returns ErrJunctionUnsupported.
func InstallJunction(base, relative, target string, winAttrs uint32) ([]error, error) {
	clean, err := CleanRelative(relative)
	if err != nil {
		return nil, err
	}
	if err := ValidJunctionTarget(target); err != nil {
		return nil, err
	}
	return installJunction(base, clean, target, winAttrs)
}

// EnsureNoReparsePointsAlong refuses when any component of relative beneath
// base that already exists is a reparse point (a symlink, junction or mount
// point). The restore calls it on a junction target it rewrote into the
// restore location: lexical containment alone would still let the junction
// resolve through a restored symlink that points elsewhere.
func EnsureNoReparsePointsAlong(base, relative string) error {
	clean, err := CleanRelative(relative)
	if err != nil {
		return err
	}
	return ensureNoReparsePointsAlong(base, clean)
}
