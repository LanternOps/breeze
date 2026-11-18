package backup

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// --- #11857 review: two manifests for one snapshot --------------------------
//
// Retention and restore must agree on which manifest is a snapshot's. Restore
// reads snapshots/<id>/manifest.json exactly; retention recognizes a manifest
// by its folded name and ID. When two listed manifests fold to one snapshot
// (two spellings in one directory on a case-sensitive vault, or two
// directories whose IDs differ only by case), retention cannot know which one
// restore will read, so it deletes nothing and names both.

// caseSensitiveVaultStore is a vault provider modelling a case-sensitive
// filesystem (ext4): every distinct spelling is a distinct object.
type caseSensitiveVaultStore struct {
	mu    sync.Mutex
	files map[string][]byte
}

func newCaseSensitiveVaultStore() *caseSensitiveVaultStore {
	return &caseSensitiveVaultStore{files: map[string][]byte{}}
}

func (s *caseSensitiveVaultStore) Upload(localPath, remotePath string) error {
	data, err := os.ReadFile(localPath)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.files[remotePath] = data
	return nil
}

func (s *caseSensitiveVaultStore) Download(remotePath, localPath string) error {
	s.mu.Lock()
	data, ok := s.files[remotePath]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("%w: %s", providers.ErrObjectNotFound, remotePath)
	}
	return os.WriteFile(localPath, data, 0o600)
}

func (s *caseSensitiveVaultStore) Delete(remotePath string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.files, remotePath)
	return nil
}

func (s *caseSensitiveVaultStore) List(prefix string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	prefix = strings.TrimSuffix(prefix, "/")
	var out []string
	for key := range s.files {
		if key == prefix || strings.HasPrefix(key, prefix+"/") {
			out = append(out, key)
		}
	}
	sort.Strings(out)
	return out, nil
}

func (s *caseSensitiveVaultStore) keys() []string {
	out, _ := s.List(snapshotRootDir)
	return out
}

// putStrayManifest writes a manifest naming snap (newer, with no files) at
// key, which is not snapshots/<snap.ID>/manifest.json.
func putStrayManifest(t *testing.T, p providers.BackupProvider, key string, snap Snapshot) {
	t.Helper()
	data, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	putVaultObject(t, p, key, string(data))
}

func requireNamesBoth(t *testing.T, what string, err error, keys ...string) {
	t.Helper()
	if err == nil {
		t.Errorf("%s reported success", what)
		return
	}
	for _, key := range keys {
		if !strings.Contains(err.Error(), key) {
			t.Errorf("%s error does not name %s: %v", what, key, err)
		}
	}
}

// syncedCaseSensitiveVault backs up base then an incremental X that references
// base's unchanged file, and syncs both into a case-sensitive vault.
func syncedCaseSensitiveVault(t *testing.T) (vm *VaultManager, vault *caseSensitiveVaultStore, base, x *Snapshot, files map[string]string) {
	t.Helper()
	primary := privateTestLocalProvider(t, t.TempDir())
	src := t.TempDir()
	files = map[string]string{"b.txt": "b bytes, unchanged in every run", "c.txt": "c bytes, first version"}
	base = vaultTestRun(t, primary, src, files, nil)
	files["c.txt"] = "c bytes, second version, longer"
	x = vaultTestRun(t, primary, src, files, base)
	if len(referencedKeys(x)) != 1 {
		t.Fatalf("control: X must reference base's b, got %v", referencedKeys(x))
	}
	vault = newCaseSensitiveVaultStore()
	vm = newFoldingVaultManager(primary, 5, vault)
	for _, snap := range []*Snapshot{base, x} {
		if _, err := vm.SyncSnapshot(snap.ID); err != nil {
			t.Fatal(err)
		}
	}
	return vm, vault, base, x, files
}

// The reviewer's repro: a stray snapshots/X/MANIFEST.JSON naming X (newer, no
// files) beside the real manifest.json. Retention 1 used to keep the stray,
// drop the real one, skip it because its ID folds onto the kept one, and
// delete base's object that the real X references, while returning nil.
func TestVaultRetention_TwoManifestSpellingsInOneSnapshotDirectoryDeleteNothing(t *testing.T) {
	vm, vault, _, x, files := syncedCaseSensitiveVault(t)
	realKey := path.Join(snapshotRootDir, x.ID, snapshotManifestKey)
	strayKey := path.Join(snapshotRootDir, x.ID, "MANIFEST.JSON")
	putStrayManifest(t, vault, strayKey, Snapshot{ID: x.ID, Timestamp: x.Timestamp.Add(time.Hour)})
	before := vault.keys()

	_, err := vm.readVaultSnapshots()
	requireNamesBoth(t, "readVaultSnapshots", err, realKey, strayKey)

	vm.config.RetentionCount = 1
	requireNamesBoth(t, "retention", vm.EnforceRetention(), realKey, strayKey)
	if after := vault.keys(); !reflect.DeepEqual(before, after) {
		t.Fatalf("retention deleted objects although two manifests name snapshot %s:\nbefore %v\nafter  %v", x.ID, before, after)
	}
	if got := restoreVaultSnapshot(t, vault, x.ID); !reflect.DeepEqual(got, files) {
		t.Fatalf("restore of X from the vault = %v, want %v", got, files)
	}
}

// Two snapshot directories whose IDs differ only by case are one directory on
// a case-insensitive vault: retention refuses rather than keep one and skip
// (or delete under) the other.
func TestVaultRetention_SnapshotIDsThatDifferOnlyByCaseDeleteNothing(t *testing.T) {
	store := newCaseSensitiveVaultStore()
	ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i, id := range []string{"snap-old", "snap-Case", "snap-case"} {
		own := path.Join(snapshotRootDir, id, snapshotFilesDir, "path_0", "own.txt.gz")
		putVaultObject(t, store, own, id+" bytes")
		putVaultManifest(t, store, Snapshot{ID: id, Timestamp: ts.Add(time.Duration(i) * time.Hour), Files: []SnapshotFile{{SourcePath: "/src/own.txt", BackupPath: own, Size: 3}}})
	}
	before := store.keys()
	upperKey := path.Join(snapshotRootDir, "snap-Case", snapshotManifestKey)
	lowerKey := path.Join(snapshotRootDir, "snap-case", snapshotManifestKey)

	vm := newFoldingVaultManager(privateTestLocalProvider(t, t.TempDir()), 1, store)
	_, err := vm.readVaultSnapshots()
	requireNamesBoth(t, "readVaultSnapshots", err, upperKey, lowerKey)
	requireNamesBoth(t, "retention", vm.EnforceRetention(), upperKey, lowerKey)
	if after := store.keys(); !reflect.DeepEqual(before, after) {
		t.Fatalf("retention deleted objects although two snapshot IDs fold together:\nbefore %v\nafter  %v", before, after)
	}
}

// Sync refuses to present a snapshot whose directory, on primary or in the
// vault, holds two manifests, and never copies a second manifest spelling.
func TestVaultSync_RefusesASnapshotDirectoryWithTwoManifests(t *testing.T) {
	t.Run("on-primary", func(t *testing.T) {
		_, synced, _, x, _ := syncedCaseSensitiveVault(t)
		realKey := path.Join(snapshotRootDir, x.ID, snapshotManifestKey)
		strayKey := path.Join(snapshotRootDir, x.ID, "MANIFEST.JSON")
		putStrayManifest(t, synced, strayKey, Snapshot{ID: x.ID, Timestamp: x.Timestamp.Add(time.Hour)})
		vault := newCaseSensitiveVaultStore()
		vm := newFoldingVaultManager(synced, 5, vault)
		_, err := vm.SyncSnapshot(x.ID)
		requireNamesBoth(t, "sync", err, realKey, strayKey)
		for _, key := range vault.keys() {
			if strings.Count(key, "/") == 2 && strings.EqualFold(path.Base(key), snapshotManifestKey) {
				t.Errorf("the refused sync left manifest %s in the vault", key)
			}
		}
	})
	t.Run("in-vault", func(t *testing.T) {
		vm, vault, _, x, _ := syncedCaseSensitiveVault(t)
		realKey := path.Join(snapshotRootDir, x.ID, snapshotManifestKey)
		strayKey := path.Join(snapshotRootDir, x.ID, "MANIFEST.JSON")
		putStrayManifest(t, vault, strayKey, Snapshot{ID: x.ID, Timestamp: x.Timestamp.Add(time.Hour)})
		_, err := vm.SyncSnapshot(x.ID)
		requireNamesBoth(t, "sync", err, realKey, strayKey)
	})
	// On a case-insensitive vault, snapshots/<X upper-cased> is X's directory:
	// uploading X's manifest would overwrite the other snapshot's.
	t.Run("case-insensitive-vault-holds-another-snapshot", func(t *testing.T) {
		primary := privateTestLocalProvider(t, t.TempDir())
		x := vaultTestRun(t, primary, t.TempDir(), map[string]string{"a.txt": "a bytes"}, nil)
		otherID := strings.ToUpper(x.ID)
		if otherID == x.ID {
			t.Fatalf("control: snapshot ID %s has no case to change", x.ID)
		}
		store := newFoldingVaultStore(nil)
		otherKey := path.Join(snapshotRootDir, otherID, snapshotManifestKey)
		putVaultManifest(t, store, Snapshot{ID: otherID, Timestamp: x.Timestamp.Add(-time.Hour)})
		vm := newFoldingVaultManager(primary, 5, store)
		_, err := vm.SyncSnapshot(x.ID)
		requireNamesBoth(t, "sync", err, otherKey)
		got, err := vm.readVaultSnapshots()
		if err != nil || len(got) != 1 || got[0].id != otherID {
			t.Fatalf("the refused sync changed the other snapshot's manifest: %v, %v", got, err)
		}
	})
	// Control: one manifest that the listing spells differently is the same
	// file on a case-insensitive vault; re-syncing the snapshot still works.
	t.Run("listing-spells-the-only-manifest-differently", func(t *testing.T) {
		primary := privateTestLocalProvider(t, t.TempDir())
		files := map[string]string{"a.txt": "a bytes"}
		x := vaultTestRun(t, primary, t.TempDir(), files, nil)
		store := newFoldingVaultStore(strings.ToUpper)
		vm := newFoldingVaultManager(primary, 5, store)
		for i := 0; i < 2; i++ {
			if _, err := vm.SyncSnapshot(x.ID); err != nil {
				t.Fatalf("sync %d: %v", i+1, err)
			}
		}
		if got := restoreVaultSnapshot(t, store, x.ID); !reflect.DeepEqual(got, files) {
			t.Fatalf("restore = %v, want %v", got, files)
		}
	})
}
