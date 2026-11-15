package backup

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/text/unicode/norm"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// --- #11857 review: vault keys spelled differently on disk -----------------
//
// A vault on a case-insensitive or normalization-insensitive filesystem
// (APFS, NTFS, exFAT, HFS+) stores keys that differ only by a directory's
// case under ONE directory, spelled as it was first created, and HFS+ lists
// names in NFD. The vault listing then returns a spelling that differs from
// the one a manifest records, although both address the same object.

// foldingVaultStore is a vault provider modelling such a filesystem: every
// path segment resolves to an existing directory or file whose name folds the
// same, the spelling first created is kept, and List returns names as stored
// (passed through listSpelling, e.g. NFD, when set). Its fold is plain
// lower-casing plus NFC, deliberately independent of the production fold, so
// the tests cannot pass by agreeing with themselves.
type foldingVaultStore struct {
	mu           sync.Mutex
	dirs         map[string]string // folded dir path -> stored spelling of its last segment
	files        map[string]*foldingVaultObject
	listSpelling func(segment string) string
	deleted      []string
}

type foldingVaultObject struct {
	stored string
	data   []byte
}

func newFoldingVaultStore(listSpelling func(string) string) *foldingVaultStore {
	return &foldingVaultStore{dirs: map[string]string{}, files: map[string]*foldingVaultObject{}, listSpelling: listSpelling}
}

func storeFold(s string) string { return strings.ToLower(norm.NFC.String(s)) }

func (s *foldingVaultStore) Upload(localPath, remotePath string) error {
	data, err := os.ReadFile(localPath)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	folded := storeFold(remotePath)
	if obj, ok := s.files[folded]; ok {
		obj.data = data // replaced in place; the stored spelling stays
		return nil
	}
	segs := strings.Split(remotePath, "/")
	stored := make([]string, len(segs))
	for i := 0; i < len(segs)-1; i++ {
		dir := storeFold(strings.Join(segs[:i+1], "/"))
		if spelled, ok := s.dirs[dir]; ok {
			stored[i] = spelled
		} else {
			s.dirs[dir] = segs[i]
			stored[i] = segs[i]
		}
	}
	stored[len(segs)-1] = segs[len(segs)-1]
	s.files[folded] = &foldingVaultObject{stored: strings.Join(stored, "/"), data: data}
	return nil
}

func (s *foldingVaultStore) Download(remotePath, localPath string) error {
	s.mu.Lock()
	obj, ok := s.files[storeFold(remotePath)]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("%w: %s", providers.ErrObjectNotFound, remotePath)
	}
	return os.WriteFile(localPath, obj.data, 0o600)
}

func (s *foldingVaultStore) Delete(remotePath string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleted = append(s.deleted, remotePath)
	folded := storeFold(remotePath)
	delete(s.files, folded)
	// An emptied directory is removed, as LocalProvider.Delete does, so a
	// later upload may create it under a new spelling.
	for dir := path.Dir(folded); dir != "." && dir != "/"; dir = path.Dir(dir) {
		empty := true
		for key := range s.files {
			if strings.HasPrefix(key, dir+"/") {
				empty = false
				break
			}
		}
		if !empty {
			break
		}
		delete(s.dirs, dir)
	}
	return nil
}

// List returns every object under prefix: the prefix's own segments as
// requested (a directory walk starts from the name it was given) and the
// segments below it as stored. listSpelling applies below a snapshot's own
// directory (segment 2 on); the agent creates snapshots/<id> itself.
func (s *foldingVaultStore) List(prefix string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	req := strings.Split(strings.TrimSuffix(prefix, "/"), "/")
	foldedPrefix := storeFold(strings.Join(req, "/"))
	var out []string
	for key, obj := range s.files {
		if key != foldedPrefix && !strings.HasPrefix(key, foldedPrefix+"/") {
			continue
		}
		stored := strings.Split(obj.stored, "/")
		segs := append(append([]string{}, req...), stored[len(req):]...)
		if s.listSpelling != nil {
			for i := max(len(req), 2); i < len(segs); i++ {
				segs[i] = s.listSpelling(segs[i])
			}
		}
		out = append(out, strings.Join(segs, "/"))
	}
	sort.Strings(out)
	return out, nil
}

func (s *foldingVaultStore) deletedFolded(key string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var hits []string
	for _, d := range s.deleted {
		if storeFold(d) == storeFold(key) {
			hits = append(hits, d)
		}
	}
	return hits
}

func newFoldingVaultManager(primary providers.BackupProvider, retention int, store providers.BackupProvider) *VaultManager {
	return &VaultManager{
		config:  VaultConfig{VaultPath: "folding-vault-fake", RetentionCount: retention, Enabled: true},
		primary: primary,
		vault:   store,
	}
}

// skipUnlessCaseInsensitive skips when dir's filesystem distinguishes case,
// probed by creating a name and statting a differently-cased spelling.
func skipUnlessCaseInsensitive(t *testing.T, dir string) {
	t.Helper()
	probe := filepath.Join(dir, "case-probe-Ab")
	if err := os.WriteFile(probe, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Remove(probe) }()
	if _, err := os.Stat(filepath.Join(dir, "CASE-PROBE-aB")); err != nil {
		t.Skipf("the filesystem under %s is case-sensitive; the provider-fake variants of this test cover the same path on every OS", dir)
	}
}

// vaultSpellingCase is one way a vault can spell a key differently from the
// manifest that references it.
type vaultSpellingCase struct {
	name string
	// dirA / dirB are two spellings of one directory; the first created
	// (dirA, which sorts first) is the one the vault keeps.
	dirA, dirB string
	newVault   func(t *testing.T, primary providers.BackupProvider, retention int) (*VaultManager, providers.BackupProvider)
}

func vaultSpellingCases() []vaultSpellingCase {
	fake := func(listSpelling func(string) string) func(*testing.T, providers.BackupProvider, int) (*VaultManager, providers.BackupProvider) {
		return func(_ *testing.T, primary providers.BackupProvider, retention int) (*VaultManager, providers.BackupProvider) {
			store := newFoldingVaultStore(listSpelling)
			return newFoldingVaultManager(primary, retention, store), store
		}
	}
	realFS := func(t *testing.T, primary providers.BackupProvider, retention int) (*VaultManager, providers.BackupProvider) {
		vaultDir := privateStoreTempDir(t)
		skipUnlessCaseInsensitive(t, vaultDir)
		vm, err := NewVaultManager(VaultConfig{VaultPath: vaultDir, RetentionCount: retention, Enabled: true}, primary)
		if err != nil {
			t.Fatal(err)
		}
		return vm, privateTestLocalProvider(t, vaultDir)
	}
	return []vaultSpellingCase{
		{name: "fake-case-insensitive", dirA: "Dir", dirB: "dir", newVault: fake(nil)},
		// NFC on write, NFD in the listing (HFS+); the directory spellings are
		// identical, so only normalization differs.
		{name: "fake-nfd-listing", dirA: "café", dirB: "café", newVault: fake(norm.NFD.String)},
		{name: "real-filesystem", dirA: "Dir", dirB: "dir", newVault: realFS},
	}
}

func byBaseName(files map[string]string) map[string]string {
	out := map[string]string{}
	for name, content := range files {
		out[path.Base(name)] = content
	}
	return out
}

// (a) The reviewer's scenario: snapshot A holds <dirA>/b.txt and <dirB>/c.txt,
// which the vault stores in one directory spelled dirA. The incremental B
// references A's c under the manifest spelling dirB/c.txt.gz while the vault
// listing returns dirA/c.txt.gz. Dropping A must keep that object, and B
// must restore from the vault alone byte-for-byte.
func TestVaultRetention_KeepsAReferencedObjectTheListingSpellsDifferently(t *testing.T) {
	for _, tc := range vaultSpellingCases() {
		t.Run(tc.name, func(t *testing.T) {
			primary := privateTestLocalProvider(t, t.TempDir())
			src := t.TempDir()
			bName, cName := tc.dirA+"/b.txt", tc.dirB+"/c.txt"
			files := map[string]string{bName: "b bytes, first version", cName: "c bytes, unchanged in every run"}
			a := vaultTestRun(t, primary, src, files, nil)
			files[bName] = "b bytes, second version, longer"
			b := vaultTestRun(t, primary, src, files, a)
			refs := referencedKeys(b)
			if len(refs) != 1 || !strings.HasSuffix(refs[0], "/"+tc.dirB+"/c.txt.gz") {
				t.Fatalf("control: B must reference only A's c under the manifest spelling %s, got %v", tc.dirB, refs)
			}
			staleB := ""
			for _, f := range a.Files {
				if f.BackupPath != refs[0] && f.BackupPath != "" {
					staleB = f.BackupPath
				}
			}

			vm, vault := tc.newVault(t, primary, 1)
			if _, err := vm.SyncAfterBackupFrom(primary, a.ID); err != nil {
				t.Fatal(err)
			}
			listed, err := vault.List(path.Join(snapshotRootDir, a.ID) + "/")
			if err != nil {
				t.Fatal(err)
			}
			for _, item := range listed {
				if item == refs[0] {
					t.Fatalf("control: the vault listing must spell A's c differently from the manifest (%s), got %v", refs[0], listed)
				}
			}
			if _, err := vm.SyncAfterBackupFrom(primary, b.ID); err != nil {
				t.Fatalf("sync of B + retention failed: %v", err)
			}
			if vaultHas(t, vault, path.Join(snapshotRootDir, a.ID, snapshotManifestKey)) {
				t.Error("control: retention must drop A")
			}
			if staleB != "" && downloadable(t, vault, staleB) {
				t.Errorf("A's b v1 (%s), referenced by no kept snapshot, is still in the vault", staleB)
			}
			if got := restoreVaultSnapshot(t, vault, b.ID); !reflect.DeepEqual(got, byBaseName(files)) {
				t.Fatalf("restore of B from the vault alone = %v, want %v", got, byBaseName(files))
			}
		})
	}
}

func downloadable(t *testing.T, p providers.BackupProvider, key string) bool {
	t.Helper()
	dst := filepath.Join(t.TempDir(), "probe")
	return p.Download(key, dst) == nil
}

// (b) A failed sync deletes only what it created: an object the vault already
// held under another spelling, which a complete snapshot references, survives.
func TestVaultSync_FailedSyncKeepsAPreexistingObjectSpelledDifferently(t *testing.T) {
	for _, tc := range vaultSpellingCases() {
		t.Run(tc.name, func(t *testing.T) {
			primary := privateTestLocalProvider(t, t.TempDir())
			src := t.TempDir()
			bName, cName := tc.dirA+"/b.txt", tc.dirB+"/c.txt"
			files := map[string]string{bName: "b bytes", cName: "c bytes"}
			a := vaultTestRun(t, primary, src, files, nil)
			bFiles := map[string]string{bName: "b bytes", cName: "c bytes", "new.txt": "new in B"}
			b := vaultTestRun(t, primary, src, bFiles, a)
			if len(referencedKeys(b)) != 2 {
				t.Fatalf("control: B must reference A's b and c, got %v", referencedKeys(b))
			}
			vm, vault := tc.newVault(t, primary, 5)
			if _, err := vm.SyncSnapshot(a.ID); err != nil {
				t.Fatal(err)
			}
			// B's own new object is gone from primary, so B's sync fails after
			// it has handled A's c.
			for _, f := range b.Files {
				if f.BackupPath != "" && !isReferenceEntry(f, b.ID) {
					if err := primary.Delete(f.BackupPath); err != nil {
						t.Fatal(err)
					}
				}
			}
			if _, err := vm.SyncSnapshot(b.ID); err == nil {
				t.Fatal("control: B's sync must fail on its missing object")
			}
			if got := restoreVaultSnapshot(t, vault, a.ID); !reflect.DeepEqual(got, byBaseName(files)) {
				t.Fatalf("restore of A after B's failed sync = %v, want %v", got, byBaseName(files))
			}
		})
	}
}

// (c) A chain A <- B <- C under folded names: each sync drops the previous
// snapshot. C references one object under A's prefix (through B) and one
// under B's, each listed under a spelling its manifest does not use. C must
// restore from the vault alone, and the objects no kept snapshot references
// must still be reclaimed.
func TestVaultRetention_ChainKeepsFoldedReferencesAcrossDrops(t *testing.T) {
	for _, tc := range vaultSpellingCases() {
		t.Run(tc.name, func(t *testing.T) {
			primary := privateTestLocalProvider(t, t.TempDir())
			src := t.TempDir()
			churn := tc.dirA + "/a1.txt"
			keepA := tc.dirB + "/keep_a.txt"
			keepB := tc.dirB + "/keep_b.txt"
			files := map[string]string{churn: "churn v1", keepA: "kept since A"}
			a := vaultTestRun(t, primary, src, files, nil)
			files[churn] = "churn v2, written in B"
			files[keepB] = "kept since B"
			b := vaultTestRun(t, primary, src, files, a)
			files[churn] = "churn v3, written in C, longest"
			c := vaultTestRun(t, primary, src, files, b)
			refs := referencedKeys(c)
			if len(refs) != 2 {
				t.Fatalf("control: C must reference keep_a (under A) and keep_b (under B), got %v", refs)
			}
			var churnKeys []string
			for _, snap := range []*Snapshot{a, b} {
				for _, f := range snap.Files {
					if strings.Contains(f.BackupPath, "a1.txt") && !isReferenceEntry(f, snap.ID) {
						churnKeys = append(churnKeys, f.BackupPath)
					}
				}
			}
			if len(churnKeys) != 2 {
				t.Fatalf("control: A and B each own one churn object, got %v", churnKeys)
			}

			vm, vault := tc.newVault(t, primary, 1)
			for _, snap := range []*Snapshot{a, b, c} {
				if _, err := vm.SyncAfterBackupFrom(primary, snap.ID); err != nil {
					t.Fatalf("sync + retention of %s failed: %v", snap.ID, err)
				}
			}
			for _, dropped := range []*Snapshot{a, b} {
				if vaultHas(t, vault, path.Join(snapshotRootDir, dropped.ID, snapshotManifestKey)) {
					t.Errorf("control: retention must drop %s", dropped.ID)
				}
			}
			for _, key := range churnKeys {
				if downloadable(t, vault, key) {
					t.Errorf("%s is referenced by no kept snapshot but is still in the vault", key)
				}
			}
			if got := restoreVaultSnapshot(t, vault, c.ID); !reflect.DeepEqual(got, byBaseName(files)) {
				t.Fatalf("restore of C from the vault alone = %v, want %v", got, byBaseName(files))
			}
		})
	}
}

// (d) Nothing is deleted when the only difference between a key a kept
// manifest references and a deletion candidate is case or normalization,
// whichever segment it is in.
func TestVaultRetention_NeverDeletesAKeyThatDiffersFromAKeptKeyOnlyByFolding(t *testing.T) {
	const oldID, newID = "snap-old", "snap-new"
	shared := path.Join(snapshotRootDir, oldID, snapshotFilesDir, "path_0", "Some", "Café", "Résumé.txt.gz")
	gone := path.Join(snapshotRootDir, oldID, snapshotFilesDir, "path_0", "gone.txt.gz")
	transforms := map[string]func(string) string{
		"upper":     strings.ToUpper,
		"lower":     strings.ToLower,
		"nfd":       norm.NFD.String,
		"upper-nfd": func(s string) string { return norm.NFD.String(strings.ToUpper(s)) },
		"swapcase": func(s string) string {
			return strings.Map(func(r rune) rune {
				if l := []rune(strings.ToLower(string(r)))[0]; l != r {
					return l
				}
				return []rune(strings.ToUpper(string(r)))[0]
			}, s)
		},
	}
	for name, listSpelling := range transforms {
		t.Run(name, func(t *testing.T) {
			store := newFoldingVaultStore(listSpelling)
			ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
			putVaultObject(t, store, shared, "shared bytes")
			putVaultObject(t, store, gone, "unreferenced bytes")
			putVaultManifest(t, store, Snapshot{ID: oldID, Timestamp: ts, Files: []SnapshotFile{
				{SourcePath: "/src/Some/Café/Résumé.txt", BackupPath: shared, Size: 12},
				{SourcePath: "/src/gone.txt", BackupPath: gone, Size: 18},
			}})
			putVaultObject(t, store, path.Join(snapshotRootDir, newID, snapshotFilesDir, "path_0", "own.txt.gz"), "own")
			putVaultManifest(t, store, Snapshot{ID: newID, Timestamp: ts.Add(time.Hour), Files: []SnapshotFile{
				{SourcePath: "/src/Some/Café/Résumé.txt", BackupPath: shared, Size: 12},
				{SourcePath: "/src/own.txt", BackupPath: path.Join(snapshotRootDir, newID, snapshotFilesDir, "path_0", "own.txt.gz"), Size: 3},
			}})

			vm := newFoldingVaultManager(privateTestLocalProvider(t, t.TempDir()), 1, store)
			if err := vm.EnforceRetention(); err != nil {
				t.Fatalf("retention failed: %v", err)
			}
			if hits := store.deletedFolded(shared); len(hits) != 0 {
				t.Errorf("retention deleted %v, which differs from the kept key %s only by case or normalization", hits, shared)
			}
			if !downloadable(t, store, shared) {
				t.Errorf("the kept snapshot's object %s is gone", shared)
			}
			if downloadable(t, store, gone) {
				t.Errorf("control: the unreferenced %s must be deleted", gone)
			}
			if downloadable(t, store, path.Join(snapshotRootDir, oldID, snapshotManifestKey)) {
				t.Error("control: the old snapshot's manifest must be deleted")
			}
		})
	}
}

func putVaultObject(t *testing.T, p providers.BackupProvider, key, content string) {
	t.Helper()
	tmp := filepath.Join(t.TempDir(), "obj")
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := p.Upload(tmp, key); err != nil {
		t.Fatal(err)
	}
}

func putVaultManifest(t *testing.T, p providers.BackupProvider, snap Snapshot) {
	t.Helper()
	data, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	putVaultObject(t, p, path.Join(snapshotRootDir, snap.ID, snapshotManifestKey), string(data))
}

// failDeleteFoldingStore fails Delete for every spelling of one key.
type failDeleteFoldingStore struct {
	*foldingVaultStore
	failKey string
}

func (s *failDeleteFoldingStore) Delete(key string) error {
	if storeFold(key) == storeFold(s.failKey) {
		return fmt.Errorf("injected delete failure for %s", key)
	}
	return s.foldingVaultStore.Delete(key)
}

// A dropped snapshot's manifest is deleted last even when the listing spells
// it differently from snapshots/<id>/manifest.json: if another of its objects
// cannot be deleted, the manifest stays so the next retention finishes it.
func TestVaultRetention_ManifestListedUnderAnotherSpellingIsDeletedLast(t *testing.T) {
	const oldID, newID = "snap-old", "snap-new"
	stuck := path.Join(snapshotRootDir, oldID, snapshotFilesDir, "path_0", "stuck.txt.gz")
	store := newFoldingVaultStore(strings.ToUpper)
	ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	putVaultObject(t, store, stuck, "stuck bytes")
	putVaultManifest(t, store, Snapshot{ID: oldID, Timestamp: ts, Files: []SnapshotFile{{SourcePath: "/src/stuck.txt", BackupPath: stuck, Size: 11}}})
	putVaultManifest(t, store, Snapshot{ID: newID, Timestamp: ts.Add(time.Hour)})

	vm := newFoldingVaultManager(privateTestLocalProvider(t, t.TempDir()), 1, &failDeleteFoldingStore{foldingVaultStore: store, failKey: stuck})
	if err := vm.EnforceRetention(); err == nil {
		t.Fatal("retention reported success although a delete failed")
	}
	if !downloadable(t, store, path.Join(snapshotRootDir, oldID, snapshotManifestKey)) {
		t.Fatal("the partly-deleted snapshot's manifest was deleted, so no retention would ever finish it")
	}
	vm.vault = store
	if err := vm.EnforceRetention(); err != nil {
		t.Fatalf("retry failed: %v", err)
	}
	if downloadable(t, store, stuck) || downloadable(t, store, path.Join(snapshotRootDir, oldID, snapshotManifestKey)) {
		t.Error("the retry did not finish deleting the dropped snapshot")
	}
}

// vaultKeyFold is at least as coarse as foldObjectKey (two keys the object-key
// fold equates are always equated), and also equates the simple-uppercase
// pairs an NTFS or exFAT upcase table does (dotless i with I and i).
func TestVaultKeyFold_EquatesEverySpellingAFilesystemMay(t *testing.T) {
	same := [][2]string{
		{"snapshots/s/files/Dir/c.txt.gz", "snapshots/s/files/dir/c.txt.gz"},
		{"snapshots/s/files/café", "snapshots/s/files/café"},
		{"snapshots/s/files/CAFÉ", "snapshots/s/files/café"},
		{"snapshots/s/files/straße", "snapshots/s/files/STRASSE"},
		{"snapshots/s/files/ı.txt", "snapshots/s/files/I.txt"},
		{"snapshots/s/files/ı.txt", "snapshots/s/files/i.txt"},
		{"snapshots/s/files/K", "snapshots/s/files/k"}, // KELVIN SIGN
	}
	for _, pair := range same {
		if foldObjectKey(pair[0]) == foldObjectKey(pair[1]) && vaultKeyFold(pair[0]) != vaultKeyFold(pair[1]) {
			t.Errorf("vaultKeyFold separates %q and %q, which foldObjectKey equates", pair[0], pair[1])
		}
		if vaultKeyFold(pair[0]) != vaultKeyFold(pair[1]) {
			t.Errorf("vaultKeyFold(%q) = %q, vaultKeyFold(%q) = %q; want equal", pair[0], vaultKeyFold(pair[0]), pair[1], vaultKeyFold(pair[1]))
		}
	}
	if vaultKeyFold("snapshots/s/files/a.txt") == vaultKeyFold("snapshots/s/files/b.txt") {
		t.Error("vaultKeyFold equates distinct names")
	}
}

// The sync result counts each object once and finds its stored size although
// the vault (and, on a case-insensitive host, primary) lists it under a
// spelling the manifest does not use.
func TestVaultSync_ResultCountsEachObjectOnceUnderFoldedSpellings(t *testing.T) {
	for _, tc := range vaultSpellingCases() {
		t.Run(tc.name, func(t *testing.T) {
			primary := privateTestLocalProvider(t, t.TempDir())
			src := t.TempDir()
			a := vaultTestRun(t, primary, src, map[string]string{tc.dirA + "/b.txt": "b bytes", tc.dirB + "/c.txt": "c bytes"}, nil)
			vm, vault := tc.newVault(t, primary, 5)
			result, err := vm.SyncSnapshot(a.ID)
			if err != nil {
				t.Fatal(err)
			}
			if result.FileCount != 3 {
				t.Errorf("FileCount = %d, want 3 (b, c and the manifest)", result.FileCount)
			}
			sizer, ok := vault.(interface {
				ObjectSizes(string) (map[string]int64, error)
			})
			if !ok {
				return
			}
			sizes, err := sizer.ObjectSizes(path.Join(snapshotRootDir, a.ID))
			if err != nil {
				t.Fatal(err)
			}
			var want int64
			for _, size := range sizes {
				want += size
			}
			if want <= 0 || result.TotalBytes != want {
				t.Errorf("TotalBytes = %d, want %d (every stored object of the snapshot)", result.TotalBytes, want)
			}
		})
	}
}
