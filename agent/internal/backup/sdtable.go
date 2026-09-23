package backup

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
)

// sdTable deduplicates NTFS security-descriptor byte blobs by content hash
// and assigns each a stable 1-based slot, mirroring SnapshotFile.SDIndex's
// "0 = unknown/none" convention (Part 0 Global Constraints "NTFS security
// descriptors"). One table is built per snapshot run (see
// createSnapshotWithProgress in snapshot.go) and encoded once into
// Snapshot.SecurityDescriptors when the run finishes — see (*sdTable).encoded.
type sdTable struct {
	bySum map[string]int
	blobs [][]byte
}

func newSDTable() *sdTable {
	return &sdTable{bySum: make(map[string]int)}
}

// index returns sd's 1-based slot, assigning a new one the first time a
// given byte sequence is seen. An empty/nil sd returns 0 — "no security
// descriptor was captured for this entry" — which is also what every entry
// from a manifest written before this feature existed implicitly means,
// keeping the SDIndex field's zero value backward-compatible by
// construction (never a valid slot).
func (t *sdTable) index(sd []byte) int {
	if len(sd) == 0 {
		return 0
	}
	sum := sha256.Sum256(sd)
	key := hex.EncodeToString(sum[:])
	if i, ok := t.bySum[key]; ok {
		return i
	}
	t.blobs = append(t.blobs, append([]byte(nil), sd...))
	i := len(t.blobs)
	t.bySum[key] = i
	return i
}

// SECURITY_INFORMATION bits (winnt.h) and SECURITY_DESCRIPTOR_CONTROL bits.
const (
	ownerSecurityInformation = 0x00000001
	groupSecurityInformation = 0x00000002
	daclSecurityInformation  = 0x00000004
	saclSecurityInformation  = 0x00000008
	seDACLPresent            = 0x0004
	seSACLPresent            = 0x0010
	seSelfRelative           = 0x8000
)

// securityInfoForSD returns the SECURITY_INFORMATION mask applySecurity
// must request for a captured self-relative descriptor: only the components
// the descriptor actually carries (requesting OWNER with a zero owner
// offset would clear the owner), and the SACL only when this process holds
// SeSecurityPrivilege (requesting SACL without it fails the whole call).
// Anything that is not a self-relative SECURITY_DESCRIPTOR_RELATIVE
// (20-byte header, SE_SELF_RELATIVE set) is refused.
func securityInfoForSD(sd []byte, haveSACLPrivilege bool) (uint32, error) {
	if len(sd) < 20 {
		return 0, fmt.Errorf("security descriptor is %d bytes, shorter than its 20-byte header", len(sd))
	}
	control := uint16(sd[2]) | uint16(sd[3])<<8
	if control&seSelfRelative == 0 {
		return 0, fmt.Errorf("security descriptor is not self-relative (control %#04x)", control)
	}
	off := func(i int) uint32 {
		return uint32(sd[i]) | uint32(sd[i+1])<<8 | uint32(sd[i+2])<<16 | uint32(sd[i+3])<<24
	}
	var info uint32
	if off(4) != 0 {
		info |= ownerSecurityInformation
	}
	if off(8) != 0 {
		info |= groupSecurityInformation
	}
	if control&seDACLPresent != 0 {
		info |= daclSecurityInformation
	}
	if control&seSACLPresent != 0 && haveSACLPrivilege {
		info |= saclSecurityInformation
	}
	return info, nil
}

// encoded returns the table's contents as base64 strings, in insertion
// (slot) order, for Snapshot.SecurityDescriptors. nil (not an empty slice)
// when the table is empty, so json's omitempty on that field actually omits
// it — a manifest with no captured security descriptors stays
// byte-identical to one written before this feature existed.
func (t *sdTable) encoded() []string {
	if len(t.blobs) == 0 {
		return nil
	}
	out := make([]string, len(t.blobs))
	for i, b := range t.blobs {
		out[i] = base64.StdEncoding.EncodeToString(b)
	}
	return out
}
