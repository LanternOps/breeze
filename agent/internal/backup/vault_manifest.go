package backup

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/objectkey"
)

// vaultManifest is what the vault needs from one snapshot manifest: its
// identity, its timestamp, and every object key it references.
type vaultManifest struct {
	id        string
	timestamp time.Time
	// refs holds every non-empty BackupPath, validated.
	refs map[string]struct{}
	// externalRefs counts the refs under another snapshot's prefix.
	externalRefs int
}

// readManifestReferences decodes the manifest at localPath, which must be
// snapshotID's, and validates every object key it references. A manifest is
// data read from storage, so any key outside the snapshots namespace refuses
// the whole manifest rather than being skipped: skipping would leave the
// vault copy short of an object restore asks for.
func readManifestReferences(localPath, snapshotID string) (*vaultManifest, error) {
	m := &vaultManifest{id: snapshotID, refs: map[string]struct{}{}}
	ts, err := scanManifestReferences(localPath, snapshotID, func(key string, parsed objectkey.Parsed) {
		if _, seen := m.refs[key]; !seen {
			m.refs[key] = struct{}{}
			if parsed.SnapshotID != snapshotID {
				m.externalRefs++
			}
		}
	})
	if err != nil {
		return nil, err
	}
	m.timestamp = ts
	return m, nil
}

// scanManifestReferences decodes the manifest at localPath, which must be
// snapshotID's, validates every object key it references and passes each one
// (repeats included) to visit, which may be nil. It retains no entry, so a
// million-entry manifest costs only what visit keeps. It returns the
// manifest's timestamp.
func scanManifestReferences(localPath, snapshotID string, visit func(key string, parsed objectkey.Parsed)) (time.Time, error) {
	var keyErr error
	snap, err := decodeSnapshotManifestFile(localPath, func(f *SnapshotFile) bool {
		if keyErr != nil || f.BackupPath == "" {
			// An empty BackupPath is a content-less entry (symlink or
			// directory) with no stored object.
			return false
		}
		parsed, err := validateManifestObjectKey(f.BackupPath)
		if err != nil {
			keyErr = err
			return false
		}
		if visit != nil {
			visit(f.BackupPath, parsed)
		}
		// Retain no entry: only the keys are needed, and a manifest can list
		// millions of files.
		return false
	})
	if err != nil {
		return time.Time{}, fmt.Errorf("decode manifest: %w", err)
	}
	if keyErr != nil {
		return time.Time{}, fmt.Errorf("manifest references an invalid object key: %w", keyErr)
	}
	if snap.ID != snapshotID {
		return time.Time{}, fmt.Errorf("manifest under %s names snapshot %q", snapshotID, snap.ID)
	}
	return snap.Timestamp, nil
}

// vaultKeyFold maps an object key to the form under which the vault's
// filesystem may treat two keys as one object. The local vault can sit on a
// case-insensitive or normalization-insensitive filesystem (APFS, NTFS,
// exFAT, HFS+), where keys that differ only by case or Unicode normalization
// (in any segment, directories included) address one file, and the vault
// listing returns the spelling on disk, not the one a manifest records.
//
// It is foldObjectKey (full case folding plus NFC) with one more pass on top:
// simple uppercase, folded again, which equates the pairs an NTFS or exFAT
// upcase table does and case folding does not (dotless i with I and i).
// Being a function of foldObjectKey's result, it equates every pair that
// foldObjectKey does. It over-approximates on purpose: the vault uses it only
// to decide that an object may NOT be deleted, where equating too much keeps
// an orphan (space) and equating too little deletes a backup.
func vaultKeyFold(key string) string {
	return foldObjectKey(strings.ToUpper(foldObjectKey(key)))
}

// validateManifestObjectKey checks a key read from a manifest against the
// shared object-key contract (objectkey.Parse: snapshots/<id>/<rest>,
// '/'-separated, no empty, "." or ".." segment, no NUL), and additionally
// refuses:
//   - a snapshot manifest key: a file entry never points at one, and copying
//     one would make the vault present another snapshot it never synced.
//   - on a platform whose local store treats another byte as a separator
//     (Windows: '\'), a ".." segment between those separators. The contract
//     keeps '\' as an ordinary filename byte (a Linux name can hold one), and
//     on Linux and macOS it is one; on Windows the local store would walk it.
func validateManifestObjectKey(key string) (objectkey.Parsed, error) {
	return validateObjectKeyForSeparator(key, filepath.Separator)
}

// validateObjectKeyForSeparator is validateManifestObjectKey for a local
// store whose path separator is sep, so tests exercise the Windows rule on
// every platform.
func validateObjectKeyForSeparator(key string, sep rune) (objectkey.Parsed, error) {
	parsed, ok := objectkey.Parse(key)
	if !ok {
		return objectkey.Parsed{}, fmt.Errorf("%q is not an object key inside the snapshots namespace", key)
	}
	if parsed.Rest == snapshotManifestKey {
		return objectkey.Parsed{}, fmt.Errorf("%q names a snapshot manifest, not a file object", key)
	}
	if sep != '/' {
		for _, seg := range strings.Split(parsed.Rest, "/") {
			for _, part := range strings.Split(seg, string(sep)) {
				if part == ".." {
					return objectkey.Parsed{}, fmt.Errorf("%q walks out of its directory on this platform", key)
				}
			}
		}
	}
	return parsed, nil
}

// validVaultSnapshotID reports whether id is a single well-formed snapshot-id
// segment of the shared object-key contract.
func validVaultSnapshotID(id string) bool {
	if id == "" {
		return false
	}
	parsed, ok := objectkey.Parse(path.Join(snapshotRootDir, id, snapshotManifestKey))
	return ok && parsed.SnapshotID == id
}

// snapshotIDOfKey returns the snapshot segment of a snapshots/<id>/... key,
// or "" when key has no such segment.
func snapshotIDOfKey(key string) string {
	parts := strings.SplitN(key, "/", 3)
	if len(parts) < 3 || parts[0] != snapshotRootDir {
		return ""
	}
	return parts[1]
}

// vaultSnapshot identifies one snapshot in the vault: its id, the manifest's
// key as the vault listing spells it, and the manifest's timestamp. It holds
// none of the manifest's references, so every snapshot in the vault can be
// held at once.
type vaultSnapshot struct {
	id          string
	manifestKey string
	timestamp   time.Time
}

// vaultManifestDirID reports whether key is a snapshot manifest by folded
// name (snapshots/<id>/manifest.json under any spelling; a system-state
// manifest deeper in a snapshot prefix is not one) and returns its <id>
// segment as spelled.
func vaultManifestDirID(key string) (string, bool) {
	parts := strings.Split(key, "/")
	if len(parts) != 3 || vaultKeyFold(parts[0]) != vaultKeyFold(snapshotRootDir) ||
		vaultKeyFold(parts[2]) != vaultKeyFold(snapshotManifestKey) {
		return "", false
	}
	return parts[1], true
}

// vaultManifestsByID returns the listed keys that are snapshot manifests
// (vaultManifestDirID), grouped by the vaultKeyFold of their snapshot ID, and
// the folded IDs in listing order.
func vaultManifestsByID(items []string) (byID map[string][]string, order []string) {
	byID = map[string][]string{}
	for _, item := range items {
		id, ok := vaultManifestDirID(item)
		if !ok {
			continue
		}
		folded := vaultKeyFold(id)
		if _, seen := byID[folded]; !seen {
			order = append(order, folded)
		}
		byID[folded] = append(byID[folded], item)
	}
	return byID, order
}

// ambiguousManifestsError reports manifests that resolve to one snapshot:
// two spellings in one snapshot directory, or two directories whose IDs fold
// together (one directory on a case-insensitive vault). Restore reads
// snapshots/<id>/manifest.json exactly, so which one it reads, and so which
// objects the snapshot needs, depends on the filesystem; nothing may be
// deleted or presented as complete on the strength of either.
func ambiguousManifestsError(keys []string) error {
	return fmt.Errorf("manifests %s resolve to one snapshot, so which one restore reads depends on the vault filesystem; remove the one that is not the snapshot's",
		strings.Join(keys, " and "))
}

// readVaultSnapshots reads every snapshot manifest in the vault (the objects
// at exactly snapshots/<id>/manifest.json; a system-state manifest deeper in
// a snapshot prefix is not a snapshot) and returns them oldest-first. It
// fails when any manifest cannot be read, has an invalid id, names another
// snapshot, or references an invalid key: retention cannot know what a
// snapshot it cannot read references. Each manifest is decoded in full and
// validated, but only its identity and timestamp are kept.
//
// A manifest is recognized by its folded name (vaultKeyFold), not its exact
// spelling: a manifest the listing spelled differently and retention skipped
// would leave a snapshot whose references nothing protects. It also fails
// when two listed manifests resolve to one folded snapshot ID
// (ambiguousManifestsError): retention would keep one and drop the other,
// and the one restore reads might be the dropped one.
func (v *VaultManager) readVaultSnapshots() ([]vaultSnapshot, error) {
	items, err := v.vault.List(snapshotRootDir)
	if err != nil {
		return nil, fmt.Errorf("list vault snapshots: %w", err)
	}
	byID, order := vaultManifestsByID(items)
	var snapshots []vaultSnapshot
	var errs []error
	for _, folded := range order {
		keys := byID[folded]
		if len(keys) > 1 {
			errs = append(errs, ambiguousManifestsError(keys))
			continue
		}
		item := keys[0]
		id, _ := vaultManifestDirID(item)
		if !validVaultSnapshotID(id) {
			errs = append(errs, fmt.Errorf("manifest %s: %q is not a valid snapshot ID", item, id))
			continue
		}
		ts, err := v.scanVaultManifest(item, id, nil)
		if err != nil {
			errs = append(errs, fmt.Errorf("manifest %s could not be read: %w", item, err))
			continue
		}
		snapshots = append(snapshots, vaultSnapshot{id: id, manifestKey: item, timestamp: ts})
	}
	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	sort.SliceStable(snapshots, func(i, j int) bool {
		if !snapshots[i].timestamp.Equal(snapshots[j].timestamp) {
			return snapshots[i].timestamp.Before(snapshots[j].timestamp)
		}
		return snapshots[i].id < snapshots[j].id
	})
	return snapshots, nil
}

// checkSnapshotDirectories refuses a sync of snapshotID when its directory
// is ambiguous: primaryItems (the listing of its prefix on primary) holds
// more than one manifest spelling, or the vault holds a manifest for its
// folded ID that is not provably this snapshot's own. Copying would leave a
// vault snapshot that retention refuses to act on, or overwrite another
// snapshot's manifest on a case-insensitive vault.
func (v *VaultManager) checkSnapshotDirectories(snapshotID string, primaryItems []string) error {
	manifestKey := path.Join(snapshotRootDir, snapshotID, snapshotManifestKey)
	folded := vaultKeyFold(snapshotID)
	primaryManifests, _ := vaultManifestsByID(primaryItems)
	if keys := primaryManifests[folded]; len(keys) > 1 {
		return fmt.Errorf("on primary: %w", ambiguousManifestsError(keys))
	}
	items, err := v.vault.List(snapshotRootDir)
	if err != nil {
		return fmt.Errorf("list vault snapshots: %w", err)
	}
	vaultManifests, _ := vaultManifestsByID(items)
	keys := vaultManifests[folded]
	switch {
	case len(keys) > 1:
		return fmt.Errorf("in the vault: %w", ambiguousManifestsError(keys))
	case len(keys) == 1 && keys[0] != manifestKey:
		// One manifest listed under another spelling: on a case-insensitive
		// vault possibly this snapshot's own (the listing spells it as on
		// disk), otherwise another snapshot's or a stray. It is this
		// snapshot's only when manifestKey reads back naming snapshotID.
		if _, err := v.scanVaultManifest(manifestKey, snapshotID, nil); err != nil {
			return fmt.Errorf("the vault holds manifest %s, which is not provably snapshot %s's own: %w", keys[0], snapshotID, err)
		}
	}
	return nil
}

// readVaultManifest reads one vault manifest with its references.
func (v *VaultManager) readVaultManifest(key, id string) (*vaultManifest, error) {
	tmpPath, cleanup, err := v.downloadVaultManifest(key)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	return readManifestReferences(tmpPath, id)
}

// scanVaultManifest reads one vault manifest, passing each reference to visit
// (see scanManifestReferences), and returns its timestamp.
func (v *VaultManager) scanVaultManifest(key, id string, visit func(string, objectkey.Parsed)) (time.Time, error) {
	tmpPath, cleanup, err := v.downloadVaultManifest(key)
	if err != nil {
		return time.Time{}, err
	}
	defer cleanup()
	return scanManifestReferences(tmpPath, id, visit)
}

func (v *VaultManager) downloadVaultManifest(key string) (string, func(), error) {
	tmp, err := os.CreateTemp("", "vault-retention-manifest-*.json")
	if err != nil {
		return "", nil, fmt.Errorf("temp file: %w", err)
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	cleanup := func() { _ = os.Remove(tmpPath) }
	if err := v.vault.Download(key, tmpPath); err != nil {
		cleanup()
		return "", nil, err
	}
	return tmpPath, cleanup, nil
}

func sortedKeys(set map[string]struct{}) []string {
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
