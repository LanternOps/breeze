package bmr

import (
	"regexp"
	"strings"
)

// objectKeyPattern mirrors apps/api/src/services/backupObjectKey.ts's
// parseBackupObjectKey exactly: no trimming, no case folding, no
// percent-decoding beyond the transport's single decode. See
// docs/superpowers/plans/backup/_w09-part0.md §1 and
// testdata/object-key-vectors.json, which pins both sides to identical
// behavior.
var objectKeyPattern = regexp.MustCompile(`^snapshots/([A-Za-z0-9][A-Za-z0-9._-]{0,254})/(.+)$`)

// ParsedObjectKey is the decomposition of a valid backup object key into
// its owning snapshot id and the remainder of the path.
type ParsedObjectKey struct {
	SnapshotID string
	Rest       string
}

// ParseObjectKey validates key against the shared object-key contract and,
// if valid, returns its decomposition. Pure string operations only — no
// filepath.Clean, no case folding, no decoding.
//
// '/' is the ONLY separator. A backslash is an ordinary filename byte
// inside a rest segment (D-W09-2, #6491 KIT lab: every systemd Linux host
// ships `system-systemd\x2dcryptsetup.slice`, and backup.go writes the name
// into the key verbatim — filepath.ToSlash is a no-op on Linux, and a
// Windows name can never contain one). The snapshot-id character class
// still excludes it and a key using backslash AS a separator never matches
// `^snapshots/`. Stored objects already carry the literal byte and are
// compared verbatim on both sides, so admitting it verbatim is the only
// backward-compatible reading; never split on it and never use
// filepath.Clean here (on Windows it would turn the byte into a separator).
func ParseObjectKey(key string) (ParsedObjectKey, bool) {
	if strings.Contains(key, "\x00") {
		return ParsedObjectKey{}, false
	}
	m := objectKeyPattern.FindStringSubmatch(key)
	if m == nil {
		return ParsedObjectKey{}, false
	}
	snapshotID, rest := m[1], m[2]
	if rest == "" || strings.HasSuffix(rest, "/") {
		return ParsedObjectKey{}, false
	}
	for _, seg := range strings.Split(rest, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return ParsedObjectKey{}, false
		}
	}
	return ParsedObjectKey{SnapshotID: snapshotID, Rest: rest}, true
}

// IsExternalObjectKey classifies key relative to ownSnapshotID: external is
// true when key is a valid object key whose snapshot segment differs
// (exact, case-sensitive) from ownSnapshotID. ok is false when key fails
// ParseObjectKey — the caller MUST treat that as a hard refusal, never as
// "own" (fail closed on an unparseable key).
func IsExternalObjectKey(key, ownSnapshotID string) (external bool, originID string, ok bool) {
	parsed, valid := ParseObjectKey(key)
	if !valid {
		return false, "", false
	}
	return parsed.SnapshotID != ownSnapshotID, parsed.SnapshotID, true
}
