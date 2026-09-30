package backup

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Restored security descriptors are applied as captured only when every
// principal they name means the same thing on the machine being restored to.
// Everything in this file is pure (string and byte handling only) so the
// decision is tested on every platform; sd_windows.go reads the principals
// out of a real descriptor and resolves the machine's domains.

// knownDomains are the domain SIDs whose accounts the restore target
// recognises: its own account domain (local users and groups), its primary
// (joined) domain, and the domains that primary domain trusts. Empty strings
// are "none".
type knownDomains struct {
	account, primary string
	trusted          []string
}

// wellKnownExact are fixed principals with the same meaning on every Windows
// machine: LocalSystem, LocalService, NetworkService, Everyone, Authenticated
// Users.
var wellKnownExact = map[string]bool{
	"S-1-5-18": true,
	"S-1-5-19": true,
	"S-1-5-20": true,
	"S-1-1-0":  true,
	"S-1-5-11": true,
}

// wellKnownPrefixes are machine-independent SID families. exactly means one
// sub-authority must follow the prefix (BUILTIN aliases, the creator SIDs);
// otherwise one or more may (service SIDs: S-1-5-80-0 or a five-part name
// hash; app-package SIDs).
var wellKnownPrefixes = []struct {
	prefix  string
	exactly bool
}{
	{"S-1-5-32", true}, // BUILTIN\Administrators, Users, …
	{"S-1-3", true},    // CREATOR OWNER, CREATOR GROUP, OWNER RIGHTS, …
	{"S-1-5-80", false},
	{"S-1-15-2", false},
}

// sidAllowed reports whether sid names a principal the restore target
// recognises: a well-known SID, or an account whose SID is exactly one RID
// after one of the known domains. A malformed SID is never allowed.
func sidAllowed(sid string, k knownDomains) bool {
	if !validSIDString(sid) {
		return false
	}
	if wellKnownExact[sid] {
		return true
	}
	for _, w := range wellKnownPrefixes {
		if extra, ok := ridsAfter(sid, w.prefix); ok && (extra == 1 || (!w.exactly && extra > 1)) {
			return true
		}
	}
	for _, domain := range append([]string{k.account, k.primary}, k.trusted...) {
		if domain == "" || !validSIDString(domain) {
			continue
		}
		if extra, ok := ridsAfter(sid, domain); ok && extra == 1 {
			return true
		}
	}
	return false
}

// ridsAfter reports how many sub-authorities sid carries after prefix, and
// whether prefix is a whole-component prefix of sid at all ("S-1-5-32" is a
// prefix of "S-1-5-32-544", never of "S-1-5-320-544").
func ridsAfter(sid, prefix string) (int, bool) {
	if !strings.HasPrefix(sid, prefix+"-") {
		return 0, false
	}
	return strings.Count(sid[len(prefix):], "-"), true
}

// validSIDString accepts only the canonical string form a SID is rendered in
// (sidFromBytes, ConvertSidToStringSid): "S-1-", a decimal identifier
// authority, then up to 15 decimal 32-bit sub-authorities, no empty
// components, no signs, no leading zeros.
func validSIDString(s string) bool {
	if !strings.HasPrefix(s, "S-1-") {
		return false
	}
	parts := strings.Split(s[len("S-1-"):], "-")
	if len(parts) > 16 {
		return false
	}
	for i, p := range parts {
		if p == "" || (len(p) > 1 && p[0] == '0') {
			return false
		}
		for _, r := range p {
			if r < '0' || r > '9' {
				return false
			}
		}
		bits := 32
		if i == 0 {
			bits = 48
		}
		if _, err := strconv.ParseUint(p, 10, bits); err != nil {
			return false
		}
	}
	return true
}

// sidFromBytes renders a binary SID (revision, sub-authority count, 48-bit
// big-endian identifier authority, little-endian 32-bit sub-authorities) in
// ConvertSidToStringSid's form. Bytes after the SID are ignored; a SID that
// does not fit b is an error.
func sidFromBytes(b []byte) (string, error) {
	if len(b) < 8 {
		return "", errors.New("SID is shorter than its 8-byte header")
	}
	if b[0] != 1 {
		return "", fmt.Errorf("SID revision %d is not 1", b[0])
	}
	count := int(b[1])
	if count > 15 {
		return "", fmt.Errorf("SID has %d sub-authorities, more than 15", count)
	}
	if len(b) < 8+4*count {
		return "", fmt.Errorf("SID with %d sub-authorities does not fit %d bytes", count, len(b))
	}
	var authority uint64
	for _, c := range b[2:8] {
		authority = authority<<8 | uint64(c)
	}
	var sb strings.Builder
	if authority < 1<<32 {
		fmt.Fprintf(&sb, "S-1-%d", authority)
	} else {
		fmt.Fprintf(&sb, "S-1-0x%012X", authority)
	}
	for i := 0; i < count; i++ {
		fmt.Fprintf(&sb, "-%d", binary.LittleEndian.Uint32(b[8+4*i:]))
	}
	return sb.String(), nil
}

// ACE types (winnt.h) whose trustee SID directly follows the 4-byte access
// mask, and the object ACE types that put a flags word and up to two GUIDs in
// between.
const (
	aceTypeMandatoryLabel = 0x11
	aceObjectTypePresent  = 0x1
	aceInheritedPresent   = 0x2
)

var (
	aceSIDAfterMask = map[byte]bool{
		0x00: true, // ACCESS_ALLOWED
		0x01: true, // ACCESS_DENIED
		0x02: true, // SYSTEM_AUDIT
		0x03: true, // SYSTEM_ALARM
		0x09: true, // ACCESS_ALLOWED_CALLBACK
		0x0A: true, // ACCESS_DENIED_CALLBACK
		0x0D: true, // SYSTEM_AUDIT_CALLBACK
		0x0E: true, // SYSTEM_ALARM_CALLBACK
		0x11: true, // SYSTEM_MANDATORY_LABEL
		0x12: true, // SYSTEM_RESOURCE_ATTRIBUTE
		0x13: true, // SYSTEM_SCOPED_POLICY_ID
		0x14: true, // SYSTEM_PROCESS_TRUST_LABEL
		0x15: true, // SYSTEM_ACCESS_FILTER
	}
	aceObjectTypes = map[byte]bool{
		0x05: true, // ACCESS_ALLOWED_OBJECT
		0x06: true, // ACCESS_DENIED_OBJECT
		0x07: true, // SYSTEM_AUDIT_OBJECT
		0x08: true, // SYSTEM_ALARM_OBJECT
		0x0B: true, // ACCESS_ALLOWED_CALLBACK_OBJECT
		0x0C: true, // ACCESS_DENIED_CALLBACK_OBJECT
		0x0F: true, // SYSTEM_AUDIT_CALLBACK_OBJECT
		0x10: true, // SYSTEM_ALARM_CALLBACK_OBJECT
	}
)

// aceTrustee returns the trustee SID of one raw ACE (header included), and
// whether it is a mandatory-label entry. An ACE type whose layout is not
// known here is an error: its trustee cannot be judged, so the caller treats
// it as an unknown principal.
func aceTrustee(ace []byte) (sid string, label bool, err error) {
	if len(ace) < 8 {
		return "", false, errors.New("access entry is shorter than its header and mask")
	}
	size := int(binary.LittleEndian.Uint16(ace[2:4]))
	if size < 8 || size > len(ace) {
		return "", false, fmt.Errorf("access entry size %d does not fit %d bytes", size, len(ace))
	}
	ace = ace[:size]
	typ := ace[0]
	offset := 8
	switch {
	case aceSIDAfterMask[typ]:
	case aceObjectTypes[typ]:
		if len(ace) < 12 {
			return "", false, errors.New("object access entry has no flags word")
		}
		flags := binary.LittleEndian.Uint32(ace[8:12])
		offset = 12
		if flags&aceObjectTypePresent != 0 {
			offset += 16
		}
		if flags&aceInheritedPresent != 0 {
			offset += 16
		}
		if offset > len(ace) {
			return "", false, errors.New("object access entry GUIDs run past its size")
		}
	default:
		return "", false, fmt.Errorf("access entry type %#x is not supported", typ)
	}
	sid, err = sidFromBytes(ace[offset:])
	if err != nil {
		return "", false, fmt.Errorf("access entry trustee: %w", err)
	}
	return sid, typ == aceTypeMandatoryLabel, nil
}

// aceEntry is one ACE's trustee as read from a descriptor.
type aceEntry struct {
	sid        string
	label      bool // a SYSTEM_MANDATORY_LABEL entry
	unreadable bool // the entry's trustee could not be read
}

// sdPrincipals are the principals a descriptor would apply. owner/group are
// "" when the descriptor does not carry (or the restore does not set) them;
// a nil dacl is either no DACL or a NULL DACL, neither of which names a
// principal. sacl is judged only when saclApplied — the restore applies a
// SACL only while it holds SeSecurityPrivilege.
type sdPrincipals struct {
	owner, group string
	dacl         []aceEntry
	saclApplied  bool
	sacl         []aceEntry
}

// sdVerdict is what the restore does with a captured descriptor.
type sdVerdict int

const (
	// sdApply applies the descriptor as captured.
	sdApply sdVerdict = iota
	// sdApplyWithoutSACL applies owner, group and DACL; only the audit
	// entries named an unrecognised principal.
	sdApplyWithoutSACL
	// sdQuarantine does not apply the descriptor: the entry gets the
	// restrictive quarantine descriptor instead (never the parent's ACL).
	sdQuarantine
)

func (v sdVerdict) String() string {
	switch v {
	case sdApply:
		return "apply"
	case sdApplyWithoutSACL:
		return "apply-without-sacl"
	case sdQuarantine:
		return "quarantine"
	}
	return fmt.Sprintf("sdVerdict(%d)", int(v))
}

// judgeDescriptor decides what the restore does with a descriptor naming p
// on a machine that recognises k. An unrecognised owner, group or DACL
// trustee quarantines the entry; an unrecognised SACL trustee drops only the
// SACL. An integrity label (S-1-16-*) is a level, not a principal. reason
// names the first principal that decided the verdict ("" for sdApply).
func judgeDescriptor(p sdPrincipals, k knownDomains) (sdVerdict, string) {
	if p.owner != "" && !sidAllowed(p.owner, k) {
		return sdQuarantine, "owner " + p.owner
	}
	if p.group != "" && !sidAllowed(p.group, k) {
		return sdQuarantine, "group " + p.group
	}
	if reason := firstUnknownEntry(p.dacl, k, "access entry"); reason != "" {
		return sdQuarantine, reason
	}
	if p.saclApplied {
		if reason := firstUnknownEntry(p.sacl, k, "audit entry"); reason != "" {
			return sdApplyWithoutSACL, reason
		}
	}
	return sdApply, ""
}

func firstUnknownEntry(entries []aceEntry, k knownDomains, kind string) string {
	for _, e := range entries {
		switch {
		case e.unreadable:
			return "an " + kind + " that could not be read"
		case e.label && strings.HasPrefix(e.sid, "S-1-16-"):
			continue
		case !sidAllowed(e.sid, k):
			return kind + " for " + e.sid
		}
	}
	return ""
}
