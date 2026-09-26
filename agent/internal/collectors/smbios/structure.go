// Package smbios parses the raw SMBIOS structure table (DMTF DSP0134) as
// returned by GetSystemFirmwareTable('RSMB') on Windows (after its 8-byte
// RawSMBIOSData header) or /sys/firmware/dmi/tables/DMI on Linux.
//
// The package is pure Go with no build tags so it can be tested on every OS.
// It is deliberately strict: every field read is length-gated, and any
// structure or string-set bound violation (length past end, missing
// double-NUL terminator) fails the whole parse. Callers get either a complete,
// internally consistent result or an error — never a partial table. The one
// tolerated firmware bug is a string reference past the end of a well-formed
// string set: only that field is left unset.
package smbios

import (
	"encoding/binary"
	"fmt"
)

// MaxTableSize bounds the table the parser will accept. Real tables are a few
// KiB to low hundreds of KiB even on large servers.
const MaxTableSize = 4 * 1024 * 1024

const (
	headerLen       = 4
	typeEndOfTable  = 127
	maxStructures   = 65536
	maxStringsInSet = 255 // string references are one byte; index 0 = none
)

// Structure is one SMBIOS structure: its formatted area (including the 4-byte
// header) and its string set.
type Structure struct {
	Type      byte
	Handle    uint16
	Formatted []byte   // len == header Length; Formatted[0] == Type
	Strings   []string // Strings[0] is string number 1
}

// Length is the formatted-area length declared in the header.
func (s Structure) Length() int { return len(s.Formatted) }

// has reports whether the formatted area contains n bytes at off.
func (s Structure) has(off, n int) bool { return off >= 0 && n >= 0 && off+n <= len(s.Formatted) }

func (s Structure) byteAt(off int) (byte, bool) {
	if !s.has(off, 1) {
		return 0, false
	}
	return s.Formatted[off], true
}

func (s Structure) word(off int) (uint16, bool) {
	if !s.has(off, 2) {
		return 0, false
	}
	return binary.LittleEndian.Uint16(s.Formatted[off:]), true
}

func (s Structure) dword(off int) (uint32, bool) {
	if !s.has(off, 4) {
		return 0, false
	}
	return binary.LittleEndian.Uint32(s.Formatted[off:]), true
}

func (s Structure) qword(off int) (uint64, bool) {
	if !s.has(off, 8) {
		return 0, false
	}
	return binary.LittleEndian.Uint64(s.Formatted[off:]), true
}

// str resolves the string-reference byte at off. A field outside the
// formatted area or a zero reference yields "". A reference past the end of
// the (already bounds-validated) string set is a common OEM firmware bug —
// dmidecode prints "<BAD INDEX>" — so it degrades only that field to "" rather
// than failing the structure.
func (s Structure) str(off int) string {
	idx, ok := s.byteAt(off)
	if !ok || idx == 0 || int(idx) > len(s.Strings) {
		return ""
	}
	return s.Strings[idx-1]
}

// ParseStructures walks the structure table. It stops at the type 127
// end-of-table structure; bytes after it are ignored. A table without an end
// marker is accepted only if it is consumed exactly or the remainder is all
// zero padding.
func ParseStructures(table []byte) ([]Structure, error) {
	if len(table) > MaxTableSize {
		return nil, fmt.Errorf("smbios: table of %d bytes exceeds %d byte limit", len(table), MaxTableSize)
	}
	var out []Structure
	off := 0
	for off < len(table) {
		remaining := table[off:]
		if len(remaining) < headerLen {
			if allZero(remaining) {
				break
			}
			return nil, fmt.Errorf("smbios: truncated structure header at offset %#x (%d bytes left)", off, len(remaining))
		}
		typ := remaining[0]
		length := int(remaining[1])
		handle := binary.LittleEndian.Uint16(remaining[2:])
		if length < headerLen {
			if allZero(remaining) {
				break
			}
			return nil, fmt.Errorf("smbios: type %d at offset %#x has invalid length %d", typ, off, length)
		}
		if length > len(remaining) {
			return nil, fmt.Errorf("smbios: type %d handle %#04x at offset %#x: length %d runs past end of table (%d bytes left)",
				typ, handle, off, length, len(remaining))
		}
		strs, setLen, err := parseStringSet(remaining[length:])
		if err != nil {
			return nil, fmt.Errorf("smbios: type %d handle %#04x at offset %#x: %w", typ, handle, off, err)
		}
		out = append(out, Structure{
			Type:      typ,
			Handle:    handle,
			Formatted: remaining[:length:length],
			Strings:   strs,
		})
		if len(out) > maxStructures {
			return nil, fmt.Errorf("smbios: more than %d structures", maxStructures)
		}
		off += length + setLen
		if typ == typeEndOfTable {
			break
		}
	}
	return out, nil
}

// parseStringSet reads the string set following a formatted area. It is a
// run of NUL-terminated strings ending with an extra NUL; a structure with no
// strings is followed by two NULs. Returns the strings and the byte length of
// the whole set.
func parseStringSet(b []byte) ([]string, int, error) {
	if len(b) < 2 {
		return nil, 0, fmt.Errorf("string set truncated")
	}
	if b[0] == 0 {
		if b[1] != 0 {
			return nil, 0, fmt.Errorf("string set starts with an empty string")
		}
		return nil, 2, nil
	}
	var strs []string
	start := 0
	for i := 0; i < len(b); i++ {
		if b[i] != 0 {
			continue
		}
		if i == start {
			// Second consecutive NUL: end of set.
			return strs, i + 1, nil
		}
		if len(strs) == maxStringsInSet {
			return nil, 0, fmt.Errorf("string set has more than %d strings", maxStringsInSet)
		}
		strs = append(strs, string(b[start:i]))
		start = i + 1
	}
	return nil, 0, fmt.Errorf("string set not double-NUL terminated before end of table")
}

func allZero(b []byte) bool {
	for _, v := range b {
		if v != 0 {
			return false
		}
	}
	return true
}
