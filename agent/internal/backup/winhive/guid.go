package winhive

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"
)

// guidBytes encodes a GUID string ("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
// braces and case optional) in Win32 GUID memory order: Data1/2/3
// little-endian, Data4 as written — what IOCTL_DISK_GET_PARTITION_INFO_EX
// returns and what a MountedDevices DMIO:ID: value carries. A local copy of
// wingpt.GUIDToBytes: winhive imports nothing first-party. Pinned by
// TestGUIDBytes_MixedEndianVector.
func guidBytes(s string) ([16]byte, error) {
	var out [16]byte
	s = strings.ToLower(strings.Trim(strings.TrimSpace(s), "{}"))
	raw, err := hex.DecodeString(strings.ReplaceAll(s, "-", ""))
	if err != nil || len(raw) != 16 || len(s) != 36 || s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-' {
		return out, fmt.Errorf("winhive: malformed GUID %q", s)
	}
	binary.LittleEndian.PutUint32(out[0:4], binary.BigEndian.Uint32(raw[0:4]))
	binary.LittleEndian.PutUint16(out[4:6], binary.BigEndian.Uint16(raw[4:6]))
	binary.LittleEndian.PutUint16(out[6:8], binary.BigEndian.Uint16(raw[6:8]))
	copy(out[8:], raw[8:])
	return out, nil
}

// guidString is guidBytes' inverse (lower-case, no braces).
func guidString(b [16]byte) string {
	return fmt.Sprintf("%08x-%04x-%04x-%x-%x", binary.LittleEndian.Uint32(b[0:4]), binary.LittleEndian.Uint16(b[4:6]),
		binary.LittleEndian.Uint16(b[6:8]), b[8:10], b[10:16])
}
