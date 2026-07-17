// Package x11 speaks the X11 wire protocol (via github.com/jezek/xgb) so the
// Breeze agent can mirror and control X sessions without linking any C
// libraries (CGO stays off). This file is the pure-Go Xauthority parser and has
// no build tag so it is compiled and race-tested on every platform.
package x11

import (
	"encoding/binary"
	"errors"
)

const (
	familyLocal = 256   // FamilyLocal
	familyWild  = 65535 // FamilyWild
	mitCookie   = "MIT-MAGIC-COOKIE-1"
)

// ErrNoCookie is returned when no usable MIT-MAGIC-COOKIE-1 entry is found.
var ErrNoCookie = errors.New("no MIT-MAGIC-COOKIE-1 entry for display")

type authEntry struct {
	family  uint16
	address string
	display string
	name    string
	data    []byte
}

// FindMitMagicCookie extracts the 16-byte MIT-MAGIC-COOKIE-1 for displayNum from
// an Xauthority blob. See the doc comment on the exported symbol in the plan.
func FindMitMagicCookie(blob []byte, displayNum, hostname string) ([]byte, error) {
	entries, err := parseXauthority(blob)
	if err != nil {
		return nil, err
	}
	var staleMatch []byte
	for _, e := range entries {
		if e.name != mitCookie {
			continue
		}
		if e.display != "" && e.display != displayNum {
			continue
		}
		switch {
		case e.family == familyWild:
			return e.data, nil
		case e.family == familyLocal && e.address == hostname:
			return e.data, nil
		default:
			// Same display, MIT cookie, but hostname mismatch — remember it as a
			// stale-hostname fallback (hostname changed since the session started).
			if staleMatch == nil {
				staleMatch = e.data
			}
		}
	}
	if staleMatch != nil {
		return staleMatch, nil
	}
	return nil, ErrNoCookie
}

func parseXauthority(blob []byte) ([]authEntry, error) {
	var entries []authEntry
	pos := 0
	readField := func() ([]byte, bool) {
		if pos+2 > len(blob) {
			return nil, false
		}
		n := int(binary.BigEndian.Uint16(blob[pos:]))
		pos += 2
		if pos+n > len(blob) {
			return nil, false
		}
		f := blob[pos : pos+n]
		pos += n
		return f, true
	}
	for pos < len(blob) {
		if pos+2 > len(blob) {
			break
		}
		family := binary.BigEndian.Uint16(blob[pos:])
		pos += 2
		address, ok := readField()
		if !ok {
			break
		}
		display, ok := readField()
		if !ok {
			break
		}
		name, ok := readField()
		if !ok {
			break
		}
		data, ok := readField()
		if !ok {
			break
		}
		entries = append(entries, authEntry{
			family:  family,
			address: string(address),
			display: string(display),
			name:    string(name),
			data:    append([]byte(nil), data...),
		})
	}
	return entries, nil
}
