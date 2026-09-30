package backup

import (
	"encoding/binary"
	"strings"
	"testing"
)

func TestSIDAllowed(t *testing.T) {
	domains := knownDomains{
		account: "S-1-5-21-1-2-3",
		primary: "S-1-5-21-100-200-300",
		trusted: []string{"S-1-5-21-7-8-9", "not-a-sid", ""},
	}
	tests := []struct {
		name string
		sid  string
		want bool
	}{
		// Fixed well-known principals.
		{"local system", "S-1-5-18", true},
		{"local service", "S-1-5-19", true},
		{"network service", "S-1-5-20", true},
		{"everyone", "S-1-1-0", true},
		{"authenticated users", "S-1-5-11", true},
		{"builtin administrators", "S-1-5-32-544", true},
		{"builtin users", "S-1-5-32-545", true},
		{"creator owner", "S-1-3-0", true},
		{"owner rights", "S-1-3-4", true},
		{"trusted installer service", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", true},
		{"all services", "S-1-5-80-0", true},
		{"all application packages", "S-1-15-2-1", true},
		{"app container package", "S-1-15-2-1-2-3-4-5-6-7", true},
		{"interactive", "S-1-5-4", true},
		{"service logon", "S-1-5-6", true},
		{"network logon", "S-1-5-2", true},
		{"principal self", "S-1-5-10", true},
		{"iusr", "S-1-5-17", true},
		{"local account", "S-1-5-113", true},
		{"local account and administrator", "S-1-5-114", true},
		{"local logon", "S-1-2-0", true},
		{"console logon", "S-1-2-1", true},
		{"ntlm authentication", "S-1-5-64-10", true},
		{"iis application pool", "S-1-5-82-3006700770-424185619-1745488364-794895919-4004696415", true},
		{"virtual machine account", "S-1-5-83-1-1-2-3-4", true},
		{"user-mode driver", "S-1-5-84-0-0-0-0-0", true},
		{"window manager", "S-1-5-90-0", true},
		{"font driver host", "S-1-5-96-0", true},
		{"capability", "S-1-15-3-1024-1-2-3", true},
		{"interactive with an extra sub-authority", "S-1-5-4-1", false},
		{"unlisted fixed authority", "S-1-5-99", false},

		// Prefix confusion against the well-known set.
		{"system with an extra sub-authority", "S-1-5-18-1", false},
		{"sibling of system", "S-1-5-180", false},
		{"builtin domain itself", "S-1-5-32", false},
		{"builtin look-alike authority", "S-1-5-320-544", false},
		{"builtin with two RIDs", "S-1-5-32-544-1", false},
		{"creator authority itself", "S-1-3", false},
		{"creator with two RIDs", "S-1-3-0-1", false},
		{"service authority itself", "S-1-5-80", false},
		{"service look-alike", "S-1-5-800-1", false},
		{"package authority itself", "S-1-15-2", false},
		{"everyone look-alike", "S-1-1-00", false},
		{"null SID", "S-1-0-0", false},
		{"mandatory label", "S-1-16-8192", false},

		// Machine and domain principals: exactly one RID after a known domain.
		{"local administrator", "S-1-5-21-1-2-3-500", true},
		{"local user", "S-1-5-21-1-2-3-1001", true},
		{"primary domain user", "S-1-5-21-100-200-300-1105", true},
		{"trusted domain group", "S-1-5-21-7-8-9-513", true},
		{"account domain itself", "S-1-5-21-1-2-3", false},
		{"RID must follow the domain exactly", "S-1-5-21-1-2-30-500", false},
		{"domain prefix of a longer domain", "S-1-5-21-1-2-3-4-500", false},
		{"unrelated domain", "S-1-5-21-9-9-9-1001", false},
		{"other machine", "S-1-5-21-1-2-4-1001", false},

		// Malformed.
		{"empty", "", false},
		{"lower-case prefix", "s-1-5-18", false},
		{"revision 2", "S-2-5-18", false},
		{"empty component", "S-1-5--18", false},
		{"trailing dash", "S-1-5-18-", false},
		{"non-numeric", "S-1-5-x", false},
		{"leading zero", "S-1-5-018", false},
		{"sub-authority out of range", "S-1-5-21-1-2-3-4294967296", false},
		{"signed component", "S-1-5-+18", false},
		{"too many sub-authorities", "S-1-5-1-2-3-4-5-6-7-8-9-10-11-12-13-14-15-16", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sidAllowed(tt.sid, domains); got != tt.want {
				t.Fatalf("sidAllowed(%q) = %v, want %v", tt.sid, got, tt.want)
			}
		})
	}
}

// With no domains resolved (workgroup machine whose account domain could
// not be read), only well-known principals are allowed.
func TestSIDAllowed_NoDomains(t *testing.T) {
	if sidAllowed("S-1-5-21-1-2-3-500", knownDomains{}) {
		t.Fatal("a machine account was allowed with no known domains")
	}
	if !sidAllowed("S-1-5-18", knownDomains{}) {
		t.Fatal("local system refused with no known domains")
	}
}

// binarySID encodes a SID the way it sits inside a descriptor.
func binarySID(authority uint64, subs ...uint32) []byte {
	b := make([]byte, 8+4*len(subs))
	b[0] = 1
	b[1] = byte(len(subs))
	for i := 0; i < 6; i++ {
		b[2+i] = byte(authority >> (8 * (5 - i)))
	}
	for i, s := range subs {
		binary.LittleEndian.PutUint32(b[8+4*i:], s)
	}
	return b
}

func TestSIDFromBytes(t *testing.T) {
	tests := []struct {
		name string
		in   []byte
		want string
		ok   bool
	}{
		{"system", binarySID(5, 18), "S-1-5-18", true},
		{"administrators", binarySID(5, 32, 544), "S-1-5-32-544", true},
		{"domain user", binarySID(5, 21, 1, 2, 4294967295, 1001), "S-1-5-21-1-2-4294967295-1001", true},
		{"null authority, no subs", binarySID(0), "S-1-0", true},
		{"wide authority", binarySID(1<<40, 1), "S-1-0x010000000000-1", true},
		{"trailing bytes ignored", append(binarySID(5, 18), 0xFF, 0xFF), "S-1-5-18", true},
		{"short header", []byte{1, 0, 0}, "", false},
		{"bad revision", func() []byte { b := binarySID(5, 18); b[0] = 2; return b }(), "", false},
		{"count past buffer", func() []byte { b := binarySID(5, 18); b[1] = 2; return b }(), "", false},
		{"too many sub-authorities", func() []byte { b := make([]byte, 8+4*16); b[0] = 1; b[1] = 16; return b }(), "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := sidFromBytes(tt.in)
			if (err == nil) != tt.ok || got != tt.want {
				t.Fatalf("sidFromBytes = %q, %v; want %q ok=%v", got, err, tt.want, tt.ok)
			}
		})
	}
}

// ace builds a raw ACE: header, then body, with AceSize covering both.
func ace(typ byte, body ...[]byte) []byte {
	var b []byte
	for _, part := range body {
		b = append(b, part...)
	}
	out := make([]byte, 4, 4+len(b))
	out[0] = typ
	binary.LittleEndian.PutUint16(out[2:], uint16(4+len(b)))
	return append(out, b...)
}

func le32(v uint32) []byte {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, v)
	return b
}

func TestACETrustee(t *testing.T) {
	guid := make([]byte, 16)
	user := binarySID(5, 21, 9, 9, 9, 1001)
	tests := []struct {
		name  string
		in    []byte
		want  string
		label bool
		ok    bool
	}{
		{"allowed", ace(0x00, le32(0x1F01FF), binarySID(5, 18)), "S-1-5-18", false, true},
		{"denied", ace(0x01, le32(1), user), "S-1-5-21-9-9-9-1001", false, true},
		{"audit", ace(0x02, le32(1), user), "S-1-5-21-9-9-9-1001", false, true},
		{"allowed callback", ace(0x09, le32(1), binarySID(5, 32, 544), []byte{0xAA, 0xBB}), "S-1-5-32-544", false, true},
		{"mandatory label", ace(0x11, le32(1), binarySID(16, 8192)), "S-1-16-8192", true, true},
		{"object ace, no GUIDs", ace(0x05, le32(1), le32(0), user), "S-1-5-21-9-9-9-1001", false, true},
		{"object ace, object type", ace(0x05, le32(1), le32(1), guid, user), "S-1-5-21-9-9-9-1001", false, true},
		{"object ace, both GUIDs", ace(0x07, le32(1), le32(3), guid, guid, binarySID(5, 18)), "S-1-5-18", false, true},
		{"callback object ace", ace(0x0B, le32(1), le32(2), guid, binarySID(5, 11)), "S-1-5-11", false, true},
		{"compound ace is not read", ace(0x04, le32(1), user), "", false, false},
		{"unknown type", ace(0x30, le32(1), user), "", false, false},
		{"truncated SID", ace(0x00, le32(1), binarySID(5, 21, 1, 2, 3, 4)[:12]), "", false, false},
		{"object ace flags past end", ace(0x05, le32(1), le32(1), guid[:8]), "", false, false},
		{"size past buffer", func() []byte { b := ace(0x00, le32(1), binarySID(5, 18)); b[2] = 0xFF; return b }(), "", false, false},
		{"shorter than a header", []byte{0, 0, 4}, "", false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, label, err := aceTrustee(tt.in)
			if (err == nil) != tt.ok || got != tt.want || label != tt.label {
				t.Fatalf("aceTrustee = %q label=%v err=%v; want %q label=%v ok=%v", got, label, err, tt.want, tt.label, tt.ok)
			}
		})
	}
}

func TestJudgeDescriptor(t *testing.T) {
	domains := knownDomains{account: "S-1-5-21-1-2-3", primary: "S-1-5-21-100-200-300"}
	const (
		local   = "S-1-5-21-1-2-3-1001"
		foreign = "S-1-5-21-9-9-9-1001"
	)
	e := func(sid string) aceEntry { return aceEntry{sid: sid} }
	tests := []struct {
		name       string
		in         sdPrincipals
		want       sdVerdict
		reasonPart string
	}{
		{"all known", sdPrincipals{owner: local, group: "S-1-5-21-1-2-3-513", dacl: []aceEntry{e("S-1-5-18"), e("S-1-5-32-544"), e(local)}}, sdApply, ""},
		{"domain user", sdPrincipals{owner: "S-1-5-21-100-200-300-1105", dacl: []aceEntry{e("S-1-5-21-100-200-300-513")}}, sdApply, ""},
		{"no components carried", sdPrincipals{}, sdApply, ""},
		{"null DACL carries no trustee", sdPrincipals{owner: "S-1-5-32-544", dacl: nil}, sdApply, ""},
		{"unknown owner", sdPrincipals{owner: foreign, dacl: []aceEntry{e("S-1-5-18")}}, sdQuarantine, "owner " + foreign},
		{"unknown group", sdPrincipals{owner: local, group: foreign}, sdQuarantine, "group " + foreign},
		{"unknown DACL trustee", sdPrincipals{owner: local, dacl: []aceEntry{e("S-1-5-18"), e(foreign)}}, sdQuarantine, "access entry for " + foreign},
		{"unreadable DACL entry", sdPrincipals{owner: local, dacl: []aceEntry{{unreadable: true}}}, sdQuarantine, "could not be read"},
		{"integrity label entry is not a principal", sdPrincipals{dacl: []aceEntry{{sid: "S-1-16-8192", label: true}}}, sdApply, ""},
		{"unknown SACL trustee drops only the SACL", sdPrincipals{owner: local, dacl: []aceEntry{e(local)}, saclApplied: true, sacl: []aceEntry{e(foreign)}}, sdApplyWithoutSACL, "audit entry for " + foreign},
		{"unreadable SACL entry drops only the SACL", sdPrincipals{owner: local, saclApplied: true, sacl: []aceEntry{{unreadable: true}}}, sdApplyWithoutSACL, "could not be read"},
		{"SACL not applied is not judged", sdPrincipals{owner: local, sacl: []aceEntry{e(foreign)}}, sdApply, ""},
		{"integrity label in the SACL is not a principal", sdPrincipals{owner: local, saclApplied: true, sacl: []aceEntry{{sid: "S-1-16-4096", label: true}}}, sdApply, ""},
		{"label entry naming a non-label SID is judged", sdPrincipals{owner: local, saclApplied: true, sacl: []aceEntry{{sid: foreign, label: true}}}, sdApplyWithoutSACL, foreign},
		{"DACL decision wins over SACL", sdPrincipals{owner: local, dacl: []aceEntry{e(foreign)}, saclApplied: true, sacl: []aceEntry{e(foreign)}}, sdQuarantine, "access entry"},
		{"known SACL", sdPrincipals{owner: local, saclApplied: true, sacl: []aceEntry{e("S-1-1-0")}}, sdApply, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, reason := judgeDescriptor(tt.in, domains)
			if got != tt.want {
				t.Fatalf("verdict = %v (%q), want %v", got, reason, tt.want)
			}
			if tt.reasonPart == "" && reason != "" {
				t.Fatalf("reason = %q, want none", reason)
			}
			if !strings.Contains(reason, tt.reasonPart) {
				t.Fatalf("reason = %q, want it to contain %q", reason, tt.reasonPart)
			}
		})
	}
}
