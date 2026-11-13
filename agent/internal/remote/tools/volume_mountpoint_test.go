package tools

import (
	"encoding/binary"
	"testing"
	"unicode/utf16"
)

// mountPointBuffer builds a mount-point reparse buffer for substitute.
func mountPointBuffer(substitute string) []byte {
	sub := utf16.Encode([]rune(substitute))
	buf := make([]byte, 16+2*len(sub)+2)
	binary.LittleEndian.PutUint32(buf[0:], reparseTagMountPoint)
	binary.LittleEndian.PutUint16(buf[4:], uint16(len(buf)-8))
	binary.LittleEndian.PutUint16(buf[8:], 0)
	binary.LittleEndian.PutUint16(buf[10:], uint16(2*len(sub)))
	binary.LittleEndian.PutUint16(buf[12:], uint16(2*len(sub)+2))
	for i, c := range sub {
		binary.LittleEndian.PutUint16(buf[16+2*i:], c)
	}
	return buf
}

// A folder at which a volume is mounted names a volume root; a junction
// names an ordinary folder.
func TestVolumeMountPointTargets(t *testing.T) {
	cases := map[string]bool{
		`\??\Volume{3f2504e0-4f89-11d3-9a0c-0305e82c3301}\`:     true,
		`\??\Volume{3F2504E0-4F89-11D3-9A0C-0305E82C3301}\`:     true,
		`\??\Volume{3f2504e0-4f89-11d3-9a0c-0305e82c3301}\Data`: false,
		`\??\C:\Data\Archive`:                                   false,
		`\??\Volume{not-a-guid}\`:                               false,
		`\??\UNC\server\share\`:                                 false,
	}
	for sub, want := range cases {
		got, ok := mountPointSubstituteName(mountPointBuffer(sub))
		if !ok || got != sub {
			t.Fatalf("%q: parsed %q ok=%v", sub, got, ok)
		}
		if isVolumeRootTarget(got) != want {
			t.Errorf("%q: volume root = %v, want %v", sub, !want, want)
		}
	}
	if _, ok := mountPointSubstituteName([]byte{1, 2, 3}); ok {
		t.Error("a malformed buffer was parsed")
	}
}

// Paths on a volume reached by its GUID (one mounted at a folder, with no
// drive letter) are judged from that volume's root.
func TestScanRulesAnchorAtAVolumeNamedByGUID(t *testing.T) {
	s := &ScanScope{}
	guid := `\Volume{3f2504e0-4f89-11d3-9a0c-0305e82c3301}`
	if !s.locationProtected(guid+`\Windows\System32\config\SAM`, false, "") {
		t.Error("a credential hive at the root of a GUID-named volume was not recognised")
	}
	if s.locationProtected(guid+`\Archive\Windows\System32\config\SAM`, false, "") {
		t.Error("a name-alike folder below the volume root was treated as protected")
	}
}
