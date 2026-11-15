package bmr

import "github.com/breeze-rmm/agent/internal/backup/objectkey"

// The object-key contract lives in the leaf package objectkey so the backup
// package can use it too (bmr's tests import backup, so backup cannot import
// bmr). These names keep bmr's API; testdata/object-key-vectors.json, which
// the API's tests also read, still pins it through objectkey_test.go.

// ParsedObjectKey is the decomposition of a valid backup object key into
// its owning snapshot id and the remainder of the path.
type ParsedObjectKey = objectkey.Parsed

// ParseObjectKey validates key against the shared object-key contract; see
// objectkey.Parse.
func ParseObjectKey(key string) (ParsedObjectKey, bool) {
	return objectkey.Parse(key)
}

// IsExternalObjectKey classifies key relative to ownSnapshotID; see
// objectkey.IsExternal. ok is false when key fails ParseObjectKey — the
// caller MUST treat that as a hard refusal, never as "own".
func IsExternalObjectKey(key, ownSnapshotID string) (external bool, originID string, ok bool) {
	return objectkey.IsExternal(key, ownSnapshotID)
}
