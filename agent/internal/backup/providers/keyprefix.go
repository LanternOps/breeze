package providers

import (
	"fmt"
	"strings"
)

// KeyPrefixMaxLength is the longest valid key prefix, in the UTF-16 code
// units JavaScript's String.length counts (BACKUP_DESTINATION_PREFIX_MAX_LENGTH
// in packages/shared/src/validators/backupDestinationPrefix.ts).
const KeyPrefixMaxLength = 256

// KeyPrefixError reports why a key prefix is invalid. Reason is one of the
// string-input codes normalizeBackupDestinationPrefix reports: too_long,
// empty_or_dot_segment, unsafe_characters, reserved_segment.
type KeyPrefixError struct {
	Reason string
}

func (e *KeyPrefixError) Error() string {
	switch e.Reason {
	case "too_long":
		return fmt.Sprintf("invalid key prefix: must be at most %d characters", KeyPrefixMaxLength)
	case "empty_or_dot_segment":
		return `invalid key prefix: must not contain empty, "." or ".." segments`
	case "unsafe_characters":
		return "invalid key prefix: may only contain letters, digits and ! _ . * ' ( ) - separated by /"
	case "reserved_segment":
		return `invalid key prefix: must not contain a "snapshots" segment`
	}
	return "invalid key prefix: " + e.Reason
}

// NormalizeKeyPrefix is the Go port of normalizeBackupDestinationPrefix
// (packages/shared/src/validators/backupDestinationPrefix.ts): the S3 key
// prefix that relocates a snapshot from snapshots/<id>/... to
// <prefix>/snapshots/<id>/.... It returns "" for "no prefix". The two are
// pinned to the same table by testdata/key-prefix-vectors.json.
//
// Rules: surrounding whitespace (as JavaScript's String.prototype.trim
// defines it) and then surrounding slashes are trimmed; the result is at
// most KeyPrefixMaxLength characters; every /-separated segment is
// non-empty, not "." or "..", uses only S3 safe characters (letters,
// digits and ! _ . * ' ( ) -), and is not "snapshots" in any letter case —
// so the bucket-root snapshots/ tree and every <prefix>/snapshots/ tree are
// pairwise disjoint.
func NormalizeKeyPrefix(raw string) (string, error) {
	trimmed := strings.Trim(strings.TrimFunc(raw, isJSTrimSpace), "/")
	if trimmed == "" {
		return "", nil
	}
	if utf16Len(trimmed) > KeyPrefixMaxLength {
		return "", &KeyPrefixError{Reason: "too_long"}
	}
	for _, segment := range strings.Split(trimmed, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", &KeyPrefixError{Reason: "empty_or_dot_segment"}
		}
		for i := 0; i < len(segment); i++ {
			if !isS3SafeKeyByte(segment[i]) {
				return "", &KeyPrefixError{Reason: "unsafe_characters"}
			}
		}
		// Every byte is ASCII here, so ASCII lower-casing is exact.
		if strings.ToLower(segment) == "snapshots" {
			return "", &KeyPrefixError{Reason: "reserved_segment"}
		}
	}
	return trimmed, nil
}

func isS3SafeKeyByte(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return strings.IndexByte("!_.*'()-", c) >= 0
}

// isJSTrimSpace is the whitespace set String.prototype.trim removes
// (ECMAScript WhiteSpace + LineTerminator). It differs from unicode.IsSpace:
// U+FEFF is trimmed, U+0085 is not.
func isJSTrimSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}
