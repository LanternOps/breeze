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
func ParseObjectKey(key string) (ParsedObjectKey, bool) {
	if strings.Contains(key, "\x00") || strings.Contains(key, "\\") {
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
