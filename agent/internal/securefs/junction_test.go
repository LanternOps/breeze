package securefs

import (
	"encoding/binary"
	"strings"
	"testing"
	"unicode/utf16"
)

// decodeUTF16 reads n bytes of UTF-16LE at buf[off:].
func decodeUTF16(t *testing.T, buf []byte, off, n int) string {
	t.Helper()
	if n%2 != 0 || off+n > len(buf) {
		t.Fatalf("name [%d:%d] outside %d-byte buffer", off, off+n, len(buf))
	}
	u := make([]uint16, n/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(buf[off+2*i:])
	}
	return string(utf16.Decode(u))
}

// The layout is what FSCTL_SET_REPARSE_POINT expects for a junction: an 8-byte
// REPARSE_DATA_BUFFER header, the four MountPointReparseBuffer offset/length
// fields, then the NUL-terminated substitute ("\??\C:\...") and print names.
func TestJunctionReparseBuffer_Layout(t *testing.T) {
	const target = `C:\Users\a\Music`
	buf, err := JunctionReparseBuffer(target)
	if err != nil {
		t.Fatalf("JunctionReparseBuffer: %v", err)
	}
	if tag := binary.LittleEndian.Uint32(buf[0:]); tag != ioReparseTagMountPoint {
		t.Fatalf("tag = %#x, want IO_REPARSE_TAG_MOUNT_POINT", tag)
	}
	if got, want := int(binary.LittleEndian.Uint16(buf[4:])), len(buf)-8; got != want {
		t.Fatalf("ReparseDataLength = %d, want %d (everything after the header)", got, want)
	}
	subOff := int(binary.LittleEndian.Uint16(buf[8:]))
	subLen := int(binary.LittleEndian.Uint16(buf[10:]))
	prnOff := int(binary.LittleEndian.Uint16(buf[12:]))
	prnLen := int(binary.LittleEndian.Uint16(buf[14:]))
	path := buf[16:]
	if got := decodeUTF16(t, path, subOff, subLen); got != `\??\`+target {
		t.Fatalf("substitute name = %q", got)
	}
	if got := decodeUTF16(t, path, prnOff, prnLen); got != target {
		t.Fatalf("print name = %q", got)
	}
	// Both names are NUL-terminated; the lengths exclude the terminator.
	if path[subOff+subLen] != 0 || path[subOff+subLen+1] != 0 || path[prnOff+prnLen] != 0 || path[prnOff+prnLen+1] != 0 {
		t.Fatal("names must be NUL-terminated")
	}
	if prnOff != subOff+subLen+2 || len(path) != prnOff+prnLen+2 {
		t.Fatalf("unexpected packing: sub [%d,%d) print [%d,%d) path %d", subOff, subOff+subLen, prnOff, prnOff+prnLen, len(path))
	}
}

// InstallJunction's resume check reads an existing junction back through
// junctionTargetFromBuffer and compares it with the requested target.
func TestJunctionTargetFromBuffer_RoundTrip(t *testing.T) {
	buf, err := JunctionReparseBuffer(`D:\Data\Shared`)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := junctionTargetFromBuffer(buf)
	if !ok || got != `D:\Data\Shared` {
		t.Fatalf("junctionTargetFromBuffer = %q, %v", got, ok)
	}
	if _, ok := junctionTargetFromBuffer(buf[:12]); ok {
		t.Fatal("a truncated buffer must not parse")
	}
	other := append([]byte(nil), buf...)
	binary.LittleEndian.PutUint32(other[0:], 0xA000000C) // IO_REPARSE_TAG_SYMLINK
	if _, ok := junctionTargetFromBuffer(other); ok {
		t.Fatal("a symlink buffer is not a junction")
	}
}

func TestJunctionReparseBuffer_VolumeRootTarget(t *testing.T) {
	if _, err := JunctionReparseBuffer(`D:\`); err != nil {
		t.Fatalf("a volume root is a valid junction target: %v", err)
	}
}

// The target comes from a manifest, which is attacker-influenced input. Only an
// ordinary drive-letter path with no relative or stream components is
// accepted; anything else is refused before a reparse point is written.
func TestJunctionReparseBuffer_RejectsUnsafeTargets(t *testing.T) {
	for _, target := range []string{
		"",
		`Users\a\Music`,
		`C:Users\a`,
		`\\server\share\x`,
		`\\?\C:\x`,
		`\??\C:\x`,
		`\\?\Volume{0b6a2c5e-0000-0000-0000-100000000000}\`,
		`C:\Users\..\Windows`,
		`C:\Users\.\a`,
		`C:\Users\a\x:stream`,
		`C:/Users/a`,
		`C:\Users\\a`,
		"C:\\Users\\a\x00b",
		`C:\` + strings.Repeat("a", 9000),
	} {
		if _, err := JunctionReparseBuffer(target); err == nil {
			t.Errorf("JunctionReparseBuffer(%q) accepted an unsafe target", target)
		}
	}
}

func TestTrimJunctionTarget(t *testing.T) {
	for in, want := range map[string]string{`C:\x\`: `C:\x`, `C:\x`: `C:\x`, `C:\`: `C:\`} {
		if got := trimJunctionTarget(in); got != want {
			t.Errorf("trimJunctionTarget(%q) = %q, want %q", in, got, want)
		}
	}
}
