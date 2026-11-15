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
		if _, seen := m.refs[f.BackupPath]; !seen {
			m.refs[f.BackupPath] = struct{}{}
			if parsed.SnapshotID != snapshotID {
				m.externalRefs++
			}
		}
		// Retain no entry: only the keys are needed, and a manifest can list
		// millions of files.
		return false
	})
	if err != nil {
		return nil, fmt.Errorf("decode manifest: %w", err)
	}
	if keyErr != nil {
		return nil, fmt.Errorf("manifest references an invalid object key: %w", keyErr)
	}
	if snap.ID != snapshotID {
		return nil, fmt.Errorf("manifest under %s names snapshot %q", snapshotID, snap.ID)
	}
	m.timestamp = snap.Timestamp
	return m, nil
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
	parsed, ok := objectkey.Parse(key)
	if !ok {
		return objectkey.Parsed{}, fmt.Errorf("%q is not an object key inside the snapshots namespace", key)
	}
	if parsed.Rest == snapshotManifestKey {
		return objectkey.Parsed{}, fmt.Errorf("%q names a snapshot manifest, not a file object", key)
	}
	if filepath.Separator != '/' {
		for _, seg := range strings.Split(parsed.Rest, "/") {
			for _, part := range strings.Split(seg, string(filepath.Separator)) {
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

// readVaultSnapshots reads every snapshot manifest in the vault (the objects
// at exactly snapshots/<id>/manifest.json; a system-state manifest deeper in
// a snapshot prefix is not a snapshot) and returns them oldest-first. It
// fails when any manifest cannot be read, has an invalid id, names another
// snapshot, or references an invalid key: retention cannot know what a
// snapshot it cannot read references.
func (v *VaultManager) readVaultSnapshots() ([]vaultManifest, error) {
	items, err := v.vault.List(snapshotRootDir)
	if err != nil {
		return nil, fmt.Errorf("list vault snapshots: %w", err)
	}
	var snapshots []vaultManifest
	var errs []error
	for _, item := range items {
		parts := strings.Split(item, "/")
		if len(parts) != 3 || parts[0] != snapshotRootDir || parts[2] != snapshotManifestKey {
			continue
		}
		id := parts[1]
		if !validVaultSnapshotID(id) {
			errs = append(errs, fmt.Errorf("manifest %s: %q is not a valid snapshot ID", item, id))
			continue
		}
		m, err := v.readVaultManifest(item, id)
		if err != nil {
			errs = append(errs, fmt.Errorf("manifest %s could not be read: %w", item, err))
			continue
		}
		snapshots = append(snapshots, *m)
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

func (v *VaultManager) readVaultManifest(key, id string) (*vaultManifest, error) {
	tmp, err := os.CreateTemp("", "vault-retention-manifest-*.json")
	if err != nil {
		return nil, fmt.Errorf("temp file: %w", err)
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(tmpPath)
	if err := v.vault.Download(key, tmpPath); err != nil {
		return nil, err
	}
	return readManifestReferences(tmpPath, id)
}

func sortedKeys(set map[string]struct{}) []string {
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
