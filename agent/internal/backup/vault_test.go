package backup

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// createTestSnapshot writes a fake snapshot (manifest + one data file) into a
// LocalProvider-backed directory and returns the snapshot ID.
func createTestSnapshot(t *testing.T, basePath string, ts time.Time) string {
	t.Helper()

	provider := privateTestLocalProvider(t, basePath)
	snap := &Snapshot{
		ID:        newSnapshotID(),
		Timestamp: ts,
		Files: []SnapshotFile{
			{
				SourcePath: "/etc/hosts",
				BackupPath: "snapshots/" + "",
				Size:       42,
				ModTime:    ts,
			},
		},
		Size: 42,
	}

	// Write a dummy data file
	dataFile, err := os.CreateTemp("", "vault-test-data-*")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dataFile.WriteString("test data content for " + snap.ID); err != nil {
		t.Fatal(err)
	}
	dataFile.Close()
	defer os.Remove(dataFile.Name())

	dataKey := "snapshots/" + snap.ID + "/files/hosts.gz"
	snap.Files[0].BackupPath = dataKey

	if err := provider.Upload(dataFile.Name(), dataKey); err != nil {
		t.Fatalf("failed to upload test data: %v", err)
	}

	// Write manifest
	manifestData, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	manifestFile, err := os.CreateTemp("", "vault-test-manifest-*.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manifestFile.Write(manifestData); err != nil {
		t.Fatal(err)
	}
	manifestFile.Close()
	defer os.Remove(manifestFile.Name())

	manifestKey := "snapshots/" + snap.ID + "/manifest.json"
	if err := provider.Upload(manifestFile.Name(), manifestKey); err != nil {
		t.Fatalf("failed to upload manifest: %v", err)
	}

	return snap.ID
}

func TestVaultSync(t *testing.T) {
	primaryDir := t.TempDir()
	vaultDir := privateStoreTempDir(t)

	snapID := createTestSnapshot(t, primaryDir, time.Now().UTC())

	primary := privateTestLocalProvider(t, primaryDir)
	vm, err := NewVaultManager(VaultConfig{
		VaultPath:      vaultDir,
		RetentionCount: 5,
		Enabled:        true,
	}, primary)
	if err != nil {
		t.Fatalf("failed to create vault manager: %v", err)
	}

	syncResult, err := vm.SyncSnapshot(snapID)
	if err != nil {
		t.Fatalf("sync failed: %v", err)
	}
	if syncResult == nil || syncResult.SnapshotID != snapID {
		t.Fatalf("unexpected sync result: %+v", syncResult)
	}
	if !syncResult.ManifestVerified {
		t.Fatal("expected manifest verification to be true")
	}

	// Verify files exist in vault
	vaultProvider := privateTestLocalProvider(t, vaultDir)
	items, err := vaultProvider.List("snapshots/" + snapID)
	if err != nil {
		t.Fatalf("failed to list vault: %v", err)
	}
	if len(items) < 2 {
		t.Errorf("expected at least 2 files in vault (manifest + data), got %d", len(items))
	}

	// Verify manifest exists
	manifestPath := filepath.Join(vaultDir, "snapshots", snapID, "manifest.json")
	if _, err := os.Stat(manifestPath); os.IsNotExist(err) {
		t.Error("manifest not found in vault")
	}
}

// #8385: on a policy-managed device the backup is written through a
// payload-built provider, not the vault's startup primary (a LocalProvider over
// the default backup path). Auto-sync must read the snapshot from where the
// backup actually wrote it.
func TestVaultSyncAfterBackupFrom_ReadsTheGivenPrimary(t *testing.T) {
	writtenDir := t.TempDir()
	fallbackDir := t.TempDir()
	vaultDir := privateStoreTempDir(t)

	snapID := createTestSnapshot(t, writtenDir, time.Now().UTC())

	vm, err := NewVaultManager(VaultConfig{VaultPath: vaultDir, RetentionCount: 5, Enabled: true},
		privateTestLocalProvider(t, fallbackDir))
	if err != nil {
		t.Fatalf("failed to create vault manager: %v", err)
	}

	if _, err := vm.SyncAfterBackup(snapID); err == nil {
		t.Fatal("control: the startup primary does not hold the snapshot, so a sync through it must fail")
	}

	result, err := vm.SyncAfterBackupFrom(privateTestLocalProvider(t, writtenDir), snapID)
	if err != nil {
		t.Fatalf("sync from the backup's own provider failed: %v", err)
	}
	if result == nil || !result.ManifestVerified {
		t.Fatalf("unexpected sync result: %+v", result)
	}
	if _, err := os.Stat(filepath.Join(vaultDir, "snapshots", snapID, "manifest.json")); err != nil {
		t.Fatalf("manifest not copied into the vault: %v", err)
	}
}

func TestVaultSync_Idempotent(t *testing.T) {
	primaryDir := t.TempDir()
	vaultDir := privateStoreTempDir(t)

	snapID := createTestSnapshot(t, primaryDir, time.Now().UTC())

	primary := privateTestLocalProvider(t, primaryDir)
	vm, err := NewVaultManager(VaultConfig{
		VaultPath:      vaultDir,
		RetentionCount: 5,
		Enabled:        true,
	}, primary)
	if err != nil {
		t.Fatal(err)
	}

	// Sync twice; second should be a no-op
	if _, err := vm.SyncSnapshot(snapID); err != nil {
		t.Fatal(err)
	}
	if _, err := vm.SyncSnapshot(snapID); err != nil {
		t.Fatalf("idempotent sync failed: %v", err)
	}
}

func TestVaultRetention(t *testing.T) {
	primaryDir := t.TempDir()
	vaultDir := privateStoreTempDir(t)

	primary := privateTestLocalProvider(t, primaryDir)
	vm, err := NewVaultManager(VaultConfig{
		VaultPath:      vaultDir,
		RetentionCount: 3,
		Enabled:        true,
	}, primary)
	if err != nil {
		t.Fatal(err)
	}

	// Create and sync 5 snapshots with staggered timestamps
	baseTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var snapIDs []string
	for i := 0; i < 5; i++ {
		ts := baseTime.Add(time.Duration(i) * time.Hour)
		snapID := createTestSnapshot(t, primaryDir, ts)
		snapIDs = append(snapIDs, snapID)
		if _, err := vm.SyncSnapshot(snapID); err != nil {
			t.Fatalf("sync %d failed: %v", i, err)
		}
	}

	// Enforce retention (keep 3)
	if err := vm.EnforceRetention(); err != nil {
		t.Fatalf("retention enforcement failed: %v", err)
	}

	// Verify only 3 snapshots remain
	vaultProvider := privateTestLocalProvider(t, vaultDir)
	remaining, err := ListSnapshots(vaultProvider)
	if err != nil {
		t.Fatalf("failed to list vault snapshots: %v", err)
	}
	if len(remaining) != 3 {
		t.Errorf("expected 3 remaining snapshots, got %d", len(remaining))
	}
}

func TestVaultStatus(t *testing.T) {
	primaryDir := t.TempDir()
	vaultDir := privateStoreTempDir(t)

	primary := privateTestLocalProvider(t, primaryDir)
	vm, err := NewVaultManager(VaultConfig{
		VaultPath:      vaultDir,
		RetentionCount: 5,
		Enabled:        true,
	}, primary)
	if err != nil {
		t.Fatal(err)
	}

	// Empty vault status
	status, err := vm.GetStatus()
	if err != nil {
		t.Fatalf("status failed: %v", err)
	}
	if status.SnapshotCount != 0 {
		t.Errorf("expected 0 snapshots, got %d", status.SnapshotCount)
	}

	// Add 2 snapshots
	for i := 0; i < 2; i++ {
		ts := time.Now().UTC().Add(time.Duration(i) * time.Hour)
		snapID := createTestSnapshot(t, primaryDir, ts)
		if _, err := vm.SyncSnapshot(snapID); err != nil {
			t.Fatal(err)
		}
	}

	status, err = vm.GetStatus()
	if err != nil {
		t.Fatalf("status failed: %v", err)
	}
	if status.SnapshotCount != 2 {
		t.Errorf("expected 2 snapshots, got %d", status.SnapshotCount)
	}
	if status.TotalSizeBytes <= 0 {
		t.Errorf("expected positive total size, got %d", status.TotalSizeBytes)
	}
	if status.VaultPath != vaultDir {
		t.Errorf("expected vaultPath %s, got %s", vaultDir, status.VaultPath)
	}
	if !status.Enabled {
		t.Error("expected enabled=true")
	}
	if status.LastSyncAt == "" {
		t.Error("expected lastSyncAt to be set")
	}
}

func TestNewVaultManager_Errors(t *testing.T) {
	primary := privateTestLocalProvider(t, t.TempDir())

	// Missing vault path
	_, err := NewVaultManager(VaultConfig{}, primary)
	if err == nil {
		t.Error("expected error for empty vault path")
	}

	// Missing primary
	_, err = NewVaultManager(VaultConfig{VaultPath: t.TempDir()}, nil)
	if err == nil {
		t.Error("expected error for nil primary provider")
	}
}

// --- #11857: a vault copy of an incremental snapshot -----------------------

const vaultTestIdentity = "local|vault-test|device|file"

// vaultTestRun is one file backup into primary: name → content. Files whose
// content and modTime are unchanged since prev are referenced, not re-uploaded.
func vaultTestRun(t *testing.T, primary *providers.LocalProvider, srcDir string, files map[string]string, prev *Snapshot) *Snapshot {
	t.Helper()
	modTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	var walked []backupFile
	for _, name := range names {
		p := filepath.Join(srcDir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(files[name]), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, modTime, modTime); err != nil {
			t.Fatal(err)
		}
		walked = append(walked, backupFile{sourcePath: p, snapshotPath: "path_0/" + name, size: int64(len(files[name])), modTime: modTime})
	}
	snap, err := createSnapshotWithProgress(context.Background(), primary, walked, nil, nil, prev, nil, withRunIdentity(vaultTestIdentity))
	if err != nil {
		t.Fatalf("backup run failed: %v", err)
	}
	// Distinct manifest timestamps, so ListSnapshots orders runs as made.
	time.Sleep(5 * time.Millisecond)
	return snap
}

// restoreVaultSnapshot restores snapshotID through the vault's own provider
// alone and returns restored file name → content.
func restoreVaultSnapshot(t *testing.T, vault providers.BackupProvider, snapshotID string) map[string]string {
	t.Helper()
	target := t.TempDir()
	result, err := RestoreFromSnapshot(vault, RestoreConfig{SnapshotID: snapshotID, TargetPath: target, WorkRoot: t.TempDir()}, nil)
	if err != nil {
		t.Fatalf("restore from the vault failed: %v", err)
	}
	if result.Status != "completed" || result.FilesFailed != 0 {
		t.Fatalf("restore from the vault: status %s, %d failed %v", result.Status, result.FilesFailed, result.FailedFiles)
	}
	got := map[string]string{}
	if err := filepath.WalkDir(target, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, readErr := os.ReadFile(p)
		if readErr != nil {
			return readErr
		}
		got[d.Name()] = string(data)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return got
}

func vaultHas(t *testing.T, vault providers.BackupProvider, key string) bool {
	t.Helper()
	items, err := vault.List(key)
	if err != nil {
		t.Fatalf("list %s: %v", key, err)
	}
	for _, item := range items {
		if item == key {
			return true
		}
	}
	return false
}

func referencedKeys(snap *Snapshot) []string {
	var keys []string
	for _, f := range snap.Files {
		if isReferenceEntry(f, snap.ID) {
			keys = append(keys, f.BackupPath)
		}
	}
	return keys
}

func newVaultTestManager(t *testing.T, primary providers.BackupProvider, retention int) (*VaultManager, *providers.LocalProvider) {
	t.Helper()
	vaultDir := privateStoreTempDir(t)
	vm, err := NewVaultManager(VaultConfig{VaultPath: vaultDir, RetentionCount: retention, Enabled: true}, primary)
	if err != nil {
		t.Fatal(err)
	}
	return vm, privateTestLocalProvider(t, vaultDir)
}

// The vault copy of an incremental snapshot holds every object its manifest
// references, including those under the earlier snapshot's prefix, so a
// restore from the vault alone returns the backed-up bytes.
func TestVaultSync_IncrementalSnapshotRestoresFromVaultAlone(t *testing.T) {
	primary := privateTestLocalProvider(t, t.TempDir())
	src := t.TempDir()
	files := map[string]string{"alpha.txt": "alpha bytes, unchanged", "beta.txt": "beta bytes, unchanged"}
	full := vaultTestRun(t, primary, src, files, nil)
	files["gamma.txt"] = "gamma is new in the second run"
	incr := vaultTestRun(t, primary, src, files, full)
	if refs := referencedKeys(incr); len(refs) != 2 {
		t.Fatalf("control: the second run must reference the first run's 2 unchanged files, got %v", refs)
	}

	vm, vault := newVaultTestManager(t, primary, 5)
	result, err := vm.SyncAfterBackupFrom(primary, incr.ID)
	if err != nil {
		t.Fatalf("sync of the incremental snapshot failed: %v", err)
	}
	for _, key := range referencedKeys(incr) {
		if !vaultHas(t, vault, key) {
			t.Errorf("vault lacks referenced object %s", key)
		}
	}
	if got := restoreVaultSnapshot(t, vault, incr.ID); !reflect.DeepEqual(got, files) {
		t.Fatalf("restore from the vault alone = %v, want %v", got, files)
	}

	// The result counts every object the vault copy holds for this
	// snapshot: its own prefix plus the referenced objects.
	own, err := vault.ObjectSizes(path.Join(snapshotRootDir, incr.ID))
	if err != nil {
		t.Fatal(err)
	}
	refSizes, err := vault.ObjectSizes(path.Join(snapshotRootDir, full.ID))
	if err != nil {
		t.Fatal(err)
	}
	var wantBytes int64
	for _, size := range own {
		wantBytes += size
	}
	for _, key := range referencedKeys(incr) {
		wantBytes += refSizes[key]
	}
	if wantBytes <= 0 || result.TotalBytes != wantBytes || result.FileCount != len(own)+2 {
		t.Errorf("sync result = %d objects / %d bytes, want %d / %d", result.FileCount, result.TotalBytes, len(own)+2, wantBytes)
	}

	// A re-sync copies nothing but reports the same vault copy.
	again, err := vm.SyncSnapshot(incr.ID)
	if err != nil {
		t.Fatalf("re-sync failed: %v", err)
	}
	if again.FileCount != result.FileCount || again.TotalBytes != result.TotalBytes {
		t.Errorf("re-sync result = %d objects / %d bytes, first sync %d / %d", again.FileCount, again.TotalBytes, result.FileCount, result.TotalBytes)
	}
}

// Retention that drops the oldest snapshot keeps the objects a kept
// snapshot references, deletes the dropped snapshot's other objects and its
// manifest, and the kept snapshot still restores from the vault.
func TestVaultRetention_KeepsObjectsAKeptSnapshotReferences(t *testing.T) {
	primary := privateTestLocalProvider(t, t.TempDir())
	src := t.TempDir()
	files := map[string]string{"alpha.txt": "alpha bytes, unchanged", "beta.txt": "beta bytes, first version"}
	full := vaultTestRun(t, primary, src, files, nil)
	files["beta.txt"] = "beta bytes, second version, longer"
	incr := vaultTestRun(t, primary, src, files, full)
	refs := referencedKeys(incr)
	if len(refs) != 1 {
		t.Fatalf("control: the second run must reference only alpha, got %v", refs)
	}
	var staleBeta string
	for _, f := range full.Files {
		if f.BackupPath != refs[0] {
			staleBeta = f.BackupPath
		}
	}
	if staleBeta == "" {
		t.Fatal("control: the first run must hold a beta object the second run does not reference")
	}

	vm, vault := newVaultTestManager(t, primary, 1)
	if _, err := vm.SyncAfterBackupFrom(primary, full.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := vm.SyncAfterBackupFrom(primary, incr.ID); err != nil {
		t.Fatalf("sync + retention failed: %v", err)
	}

	if vaultHas(t, vault, path.Join(snapshotRootDir, full.ID, snapshotManifestKey)) {
		t.Error("the dropped snapshot's manifest is still in the vault")
	}
	if vaultHas(t, vault, staleBeta) {
		t.Errorf("the dropped snapshot's unreferenced object %s is still in the vault", staleBeta)
	}
	if !vaultHas(t, vault, refs[0]) {
		t.Fatalf("retention deleted %s, which the kept snapshot references", refs[0])
	}
	if got := restoreVaultSnapshot(t, vault, incr.ID); !reflect.DeepEqual(got, files) {
		t.Fatalf("restore of the kept snapshot = %v, want %v", got, files)
	}
}

// Once no kept snapshot references an object left under a dropped
// snapshot's prefix, the next retention that drops its referrer deletes it,
// so the vault does not keep orphans forever.
func TestVaultRetention_DeletesReferencedObjectsOnceNoKeptSnapshotNeedsThem(t *testing.T) {
	primary := privateTestLocalProvider(t, t.TempDir())
	src := t.TempDir()
	files := map[string]string{"alpha.txt": "alpha bytes"}
	first := vaultTestRun(t, primary, src, files, nil)
	second := vaultTestRun(t, primary, src, files, first)
	files["alpha.txt"] = "alpha bytes, rewritten in the third run"
	third := vaultTestRun(t, primary, src, files, second)
	alphaV1 := first.Files[0].BackupPath

	vm, vault := newVaultTestManager(t, primary, 1)
	for _, snap := range []*Snapshot{first, second} {
		if _, err := vm.SyncAfterBackupFrom(primary, snap.ID); err != nil {
			t.Fatal(err)
		}
	}
	if !vaultHas(t, vault, alphaV1) {
		t.Fatal("control: the kept second snapshot references alpha v1, retention must keep it")
	}
	if _, err := vm.SyncAfterBackupFrom(primary, third.ID); err != nil {
		t.Fatal(err)
	}
	if vaultHas(t, vault, alphaV1) {
		t.Errorf("%s is referenced by no kept snapshot but is still in the vault", alphaV1)
	}
	if got := restoreVaultSnapshot(t, vault, third.ID); !reflect.DeepEqual(got, files) {
		t.Fatalf("restore of the kept snapshot = %v, want %v", got, files)
	}
}

// A referenced object the sync cannot copy fails the sync, the vault does
// not present the snapshot (no manifest), and the objects the failed sync did
// copy are removed again (no manifest would ever let retention reclaim them).
func TestVaultSync_MissingReferencedObjectFailsSync(t *testing.T) {
	primary := privateTestLocalProvider(t, t.TempDir())
	src := t.TempDir()
	files := map[string]string{"alpha.txt": "alpha bytes"}
	full := vaultTestRun(t, primary, src, files, nil)
	files["gamma.txt"] = "gamma is new in the second run"
	incr := vaultTestRun(t, primary, src, files, full)
	missing := full.Files[0].BackupPath
	if err := primary.Delete(missing); err != nil {
		t.Fatal(err)
	}

	vm, vault := newVaultTestManager(t, primary, 5)
	_, err := vm.SyncAfterBackupFrom(primary, incr.ID)
	if err == nil {
		t.Fatal("sync reported success although a referenced object is missing from primary")
	}
	if !strings.Contains(err.Error(), missing) || strings.Contains(err.Error(), "completed") {
		t.Errorf("sync error should name the missing object and never say completed: %v", err)
	}
	if vaultHas(t, vault, path.Join(snapshotRootDir, incr.ID, snapshotManifestKey)) {
		t.Error("the vault presents a snapshot whose referenced object was never copied")
	}
	left, err := vault.List(snapshotRootDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(left) != 0 {
		t.Errorf("the failed sync left objects no manifest references: %v", left)
	}
}

// A snapshot ID that is not one safe key segment is refused before any key
// is built from it.
func TestVaultSync_RefusesInvalidSnapshotID(t *testing.T) {
	primary := privateTestLocalProvider(t, t.TempDir())
	vm, vault := newVaultTestManager(t, primary, 5)
	for _, id := range []string{"", "..", "../victim", "a/b", ".hidden", `a\b`} {
		if _, err := vm.SyncSnapshot(id); err == nil || !strings.Contains(err.Error(), "not a valid snapshot ID") {
			t.Errorf("SyncSnapshot(%q) = %v, want an invalid-ID refusal", id, err)
		}
	}
	if left, _ := vault.List(snapshotRootDir); len(left) != 0 {
		t.Errorf("vault written: %v", left)
	}
}

// A manifest is data: a key outside the snapshots namespace is refused and
// the vault never presents the snapshot.
func TestVaultSync_RefusesHostileManifestKeys(t *testing.T) {
	// Control: the same fixture with a valid key syncs, so each refusal
	// below is the key's doing.
	t.Run("control", func(t *testing.T) {
		primaryDir := t.TempDir()
		primary := privateTestLocalProvider(t, primaryDir)
		key := uploadFidelityObject(t, primary, "snap-hostile", "a.txt", "a")
		writeFidelityManifest(t, primaryDir, "snap-hostile", Snapshot{
			ID:        "snap-hostile",
			Timestamp: time.Now().UTC(),
			Files:     []SnapshotFile{{SourcePath: "/src/a.txt", BackupPath: key, Size: 1}},
			Size:      1,
		})
		vm, _ := newVaultTestManager(t, primary, 5)
		if _, err := vm.SyncSnapshot("snap-hostile"); err != nil {
			t.Fatalf("control sync failed: %v", err)
		}
	})
	for _, key := range []string{
		"../outside.gz",
		"/etc/passwd",
		"snapshots/../outside.gz",
		"snapshots/snap-a/../../outside.gz",
		"snapshots/snap-a/files/../../../outside.gz",
		"outside.gz",
		"snapshots/snap-other/manifest.json",
		"snapshots//files/x.gz",
	} {
		t.Run(key, func(t *testing.T) {
			primaryDir := t.TempDir()
			primary := privateTestLocalProvider(t, primaryDir)
			snapID := "snap-hostile"
			writeFidelityManifest(t, primaryDir, snapID, Snapshot{
				ID:        snapID,
				Timestamp: time.Now().UTC(),
				Files:     []SnapshotFile{{SourcePath: "/src/a.txt", BackupPath: key, Size: 1}},
				Size:      1,
			})
			vm, vault := newVaultTestManager(t, primary, 5)
			_, err := vm.SyncSnapshot(snapID)
			if err == nil {
				t.Fatalf("sync accepted manifest key %q", key)
			}
			if !strings.Contains(err.Error(), "invalid object key") {
				t.Errorf("sync failed for another reason than the key: %v", err)
			}
			if left, _ := vault.List(snapshotRootDir); len(left) != 0 {
				t.Errorf("the vault holds objects after a refused manifest: %v", left)
			}
		})
	}
}

// When a manifest in the vault cannot be read, retention cannot know what a
// kept snapshot references, so it deletes nothing and says why.
func TestVaultRetention_UnreadableManifestBlocksDeletion(t *testing.T) {
	primary := privateTestLocalProvider(t, t.TempDir())
	src := t.TempDir()
	files := map[string]string{"alpha.txt": "alpha bytes"}
	var snaps []*Snapshot
	var prev *Snapshot
	for i := 0; i < 3; i++ {
		prev = vaultTestRun(t, primary, src, files, prev)
		snaps = append(snaps, prev)
	}
	vm, vault := newVaultTestManager(t, primary, 5)
	for _, snap := range snaps {
		if _, err := vm.SyncSnapshot(snap.ID); err != nil {
			t.Fatal(err)
		}
	}
	before, err := vault.List(snapshotRootDir)
	if err != nil {
		t.Fatal(err)
	}
	garbage := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(garbage, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := vault.Upload(garbage, path.Join(snapshotRootDir, snaps[2].ID, snapshotManifestKey)); err != nil {
		t.Fatal(err)
	}

	vm.config.RetentionCount = 1
	if err := vm.EnforceRetention(); err == nil {
		t.Fatal("retention reported success although a manifest could not be read")
	}
	after, err := vault.List(snapshotRootDir)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("retention deleted objects although a manifest was unreadable:\nbefore %v\nafter  %v", before, after)
	}
}

// A system-state manifest (snapshots/<id>/system-state/manifest.json) is not
// a snapshot: retention must not read it as one with an empty ID, whose
// prefix is the whole snapshots namespace.
func TestVaultRetention_SystemStateManifestIsNotASnapshot(t *testing.T) {
	primary := privateTestLocalProvider(t, t.TempDir())
	src := t.TempDir()
	files := map[string]string{"alpha.txt": "alpha bytes"}
	first := vaultTestRun(t, primary, src, files, nil)
	files["alpha.txt"] = "alpha bytes, second version"
	second := vaultTestRun(t, primary, src, files, first)
	ssManifest := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(ssManifest, []byte(`{"platform":"linux","artifacts":[],"schemaVersion":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, snap := range []*Snapshot{first, second} {
		if err := primary.Upload(ssManifest, path.Join(snapshotRootDir, snap.ID, systemStateDir, systemStateManifestKey)); err != nil {
			t.Fatal(err)
		}
	}

	vm, vault := newVaultTestManager(t, primary, 1)
	if _, err := vm.SyncAfterBackupFrom(primary, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := vm.SyncAfterBackupFrom(primary, second.ID); err != nil {
		t.Fatalf("sync + retention failed: %v", err)
	}
	if got := restoreVaultSnapshot(t, vault, second.ID); !reflect.DeepEqual(got, files) {
		t.Fatalf("restore of the kept snapshot = %v, want %v", got, files)
	}
	if !vaultHas(t, vault, path.Join(snapshotRootDir, second.ID, systemStateDir, systemStateManifestKey)) {
		t.Error("retention deleted the kept snapshot's system-state manifest")
	}
}

// A manifest whose id differs from the snapshot directory it sits in names
// some other prefix; retention must not act on it.
func TestVaultRetention_ManifestIDMismatchBlocksDeletion(t *testing.T) {
	primary := privateTestLocalProvider(t, t.TempDir())
	src := t.TempDir()
	files := map[string]string{"alpha.txt": "alpha bytes"}
	first := vaultTestRun(t, primary, src, files, nil)
	second := vaultTestRun(t, primary, src, files, first)
	vm, vault := newVaultTestManager(t, primary, 5)
	for _, snap := range []*Snapshot{first, second} {
		if _, err := vm.SyncSnapshot(snap.ID); err != nil {
			t.Fatal(err)
		}
	}
	before, err := vault.List(snapshotRootDir)
	if err != nil {
		t.Fatal(err)
	}
	forged := *first
	forged.ID = ""
	data, err := json.Marshal(forged)
	if err != nil {
		t.Fatal(err)
	}
	forgedPath := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(forgedPath, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := vault.Upload(forgedPath, path.Join(snapshotRootDir, first.ID, snapshotManifestKey)); err != nil {
		t.Fatal(err)
	}
	vm.config.RetentionCount = 1
	if err := vm.EnforceRetention(); err == nil {
		t.Fatal("retention reported success with a manifest whose id is not its directory")
	}
	after, err := vault.List(snapshotRootDir)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("retention deleted objects:\nbefore %v\nafter  %v", before, after)
	}
}

func TestValidateManifestObjectKey(t *testing.T) {
	for _, key := range []string{
		"snapshots/snap-a/files/path_0/a.txt.gz",
		"snapshots/snap-a/files/path_0/system-systemd\\x2dcryptsetup.slice.gz",
		"snapshots/snap-a/system-state/registry/SYSTEM",
	} {
		if _, err := validateManifestObjectKey(key); err != nil {
			t.Errorf("valid key %q refused: %v", key, err)
		}
	}
	bad := []string{"", "snapshots", "snapshots/snap-a", "snapshots/snap-a/", "snapshots/snap-a/files/\x00x",
		"snapshots/snap-a/manifest.json", "C:/snapshots/a/b", "snapshots/.hidden/x"}
	for _, key := range bad {
		if _, err := validateManifestObjectKey(key); err == nil {
			t.Errorf("hostile key %q accepted", key)
		}
	}

	// A backslash is a filename byte to a '/'-separated store (a Linux name
	// can hold `..\x`) but a separator to the Windows local store.
	backslashWalk := "snapshots/snap-a/files/..\\..\\..\\outside.gz"
	if _, err := validateObjectKeyForSeparator(backslashWalk, '/'); err != nil {
		t.Errorf("with '/' as separator, %q is a plain name and must be accepted: %v", backslashWalk, err)
	}
	if _, err := validateObjectKeyForSeparator(backslashWalk, '\\'); err == nil {
		t.Errorf("with '\\' as separator, %q walks out and must be refused", backslashWalk)
	}
	if _, err := validateObjectKeyForSeparator("snapshots/snap-a/files/system-systemd\\x2dcryptsetup.slice.gz", '\\'); err != nil {
		t.Errorf("a backslash without a .. part must be accepted on Windows too: %v", err)
	}
	if runtime.GOOS == "windows" {
		if _, err := validateManifestObjectKey(backslashWalk); err == nil {
			t.Errorf("hostile key %q accepted on Windows", backslashWalk)
		}
	}
}

// syncedVaultForBlockingTest syncs three snapshots of one file into a vault
// (retention 5) and returns the manager, the vault, the snapshots and the
// vault listing before any tampering.
func syncedVaultForBlockingTest(t *testing.T) (*VaultManager, *providers.LocalProvider, []*Snapshot, []string) {
	t.Helper()
	primary := privateTestLocalProvider(t, t.TempDir())
	src := t.TempDir()
	files := map[string]string{"alpha.txt": "alpha bytes"}
	var snaps []*Snapshot
	var prev *Snapshot
	for i := 0; i < 3; i++ {
		prev = vaultTestRun(t, primary, src, files, prev)
		snaps = append(snaps, prev)
	}
	vm, vault := newVaultTestManager(t, primary, 5)
	for _, snap := range snaps {
		if _, err := vm.SyncSnapshot(snap.ID); err != nil {
			t.Fatal(err)
		}
	}
	before, err := vault.List(snapshotRootDir)
	if err != nil {
		t.Fatal(err)
	}
	return vm, vault, snaps, before
}

func uploadVaultJSON(t *testing.T, vault *providers.LocalProvider, key string, v any) {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := vault.Upload(p, key); err != nil {
		t.Fatal(err)
	}
}

// A vault manifest holding an invalid key, or sitting in a directory that is
// not a valid snapshot ID, blocks all deletion: retention cannot trust what
// that snapshot references.
func TestVaultRetention_InvalidVaultManifestBlocksDeletion(t *testing.T) {
	cases := map[string]func(t *testing.T, vault *providers.LocalProvider, snaps []*Snapshot) string{
		"invalid key in a kept manifest": func(t *testing.T, vault *providers.LocalProvider, snaps []*Snapshot) string {
			tampered := *snaps[2]
			tampered.Files = append([]SnapshotFile(nil), tampered.Files...)
			tampered.Files = append(tampered.Files, SnapshotFile{SourcePath: "/src/x", BackupPath: "snapshots/x/../../outside.gz", Size: 1})
			key := path.Join(snapshotRootDir, tampered.ID, snapshotManifestKey)
			uploadVaultJSON(t, vault, key, tampered)
			return key
		},
		"manifest in an invalid snapshot directory": func(t *testing.T, vault *providers.LocalProvider, snaps []*Snapshot) string {
			stray := *snaps[0]
			stray.ID = ".hidden"
			key := path.Join(snapshotRootDir, ".hidden", snapshotManifestKey)
			uploadVaultJSON(t, vault, key, stray)
			return key
		},
	}
	for name, tamper := range cases {
		t.Run(name, func(t *testing.T) {
			vm, vault, snaps, _ := syncedVaultForBlockingTest(t)
			badKey := tamper(t, vault, snaps)
			before, err := vault.List(snapshotRootDir)
			if err != nil {
				t.Fatal(err)
			}
			vm.config.RetentionCount = 1
			err = vm.EnforceRetention()
			if err == nil || !strings.Contains(err.Error(), "deleted nothing") || !strings.Contains(err.Error(), badKey) {
				t.Fatalf("retention error = %v, want a deleted-nothing error naming %s", err, badKey)
			}
			after, err := vault.List(snapshotRootDir)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, after) {
				t.Fatalf("retention deleted objects:\nbefore %v\nafter  %v", before, after)
			}
		})
	}
}

// failDeleteProvider fails Delete for one key.
type failDeleteProvider struct {
	*providers.LocalProvider
	failKey string
}

func (p *failDeleteProvider) Delete(key string) error {
	if key == p.failKey {
		return errors.New("injected delete failure")
	}
	return p.LocalProvider.Delete(key)
}

// When one of a dropped snapshot's objects cannot be deleted, its manifest is
// kept so the snapshot stays listed, and the next retention finishes it.
func TestVaultRetention_PartialDeleteKeepsManifestForRetry(t *testing.T) {
	primary := privateTestLocalProvider(t, t.TempDir())
	src := t.TempDir()
	files := map[string]string{"alpha.txt": "alpha bytes, unchanged", "beta.txt": "beta bytes, first version"}
	full := vaultTestRun(t, primary, src, files, nil)
	files["beta.txt"] = "beta bytes, second version, longer"
	incr := vaultTestRun(t, primary, src, files, full)
	refs := referencedKeys(incr)
	var staleBeta string
	for _, f := range full.Files {
		if len(refs) == 1 && f.BackupPath != refs[0] {
			staleBeta = f.BackupPath
		}
	}
	if staleBeta == "" {
		t.Fatalf("control: expected one referenced and one stale object, refs %v", refs)
	}
	vm, vault := newVaultTestManager(t, primary, 5)
	for _, snap := range []*Snapshot{full, incr} {
		if _, err := vm.SyncSnapshot(snap.ID); err != nil {
			t.Fatal(err)
		}
	}
	fullManifest := path.Join(snapshotRootDir, full.ID, snapshotManifestKey)

	vm.config.RetentionCount = 1
	vm.vault = &failDeleteProvider{LocalProvider: vault, failKey: staleBeta}
	if err := vm.EnforceRetention(); err == nil {
		t.Fatal("retention reported success although a delete failed")
	}
	if !vaultHas(t, vault, fullManifest) {
		t.Fatal("the partly-deleted snapshot's manifest was deleted, so no retention would ever finish it")
	}

	vm.vault = vault
	if err := vm.EnforceRetention(); err != nil {
		t.Fatalf("retry failed: %v", err)
	}
	if vaultHas(t, vault, fullManifest) || vaultHas(t, vault, staleBeta) {
		t.Error("the retry did not finish deleting the dropped snapshot")
	}
	if !vaultHas(t, vault, refs[0]) {
		t.Errorf("the retry deleted %s, which the kept snapshot references", refs[0])
	}
}

// blockingDownloadProvider parks the first Download of key until released.
type blockingDownloadProvider struct {
	*providers.LocalProvider
	key     string
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (p *blockingDownloadProvider) Download(remotePath, localPath string) error {
	if remotePath == p.key {
		p.once.Do(func() { close(p.entered) })
		<-p.release
	}
	return p.LocalProvider.Download(remotePath, localPath)
}

// Retention from another manager over the same vault waits for an in-flight
// sync: run between the sync's copies and its manifest upload, it would
// delete an object the syncing snapshot references (no manifest names it
// yet) and the sync would then publish a snapshot missing it.
func TestVaultRetention_WaitsForAnInFlightSync(t *testing.T) {
	primary := privateTestLocalProvider(t, t.TempDir())
	src := t.TempDir()
	full := vaultTestRun(t, primary, src, map[string]string{"alpha.txt": "alpha v1"}, nil)
	vaultTestRun(t, primary, src, map[string]string{"alpha.txt": "alpha v2, rewritten"}, full)
	incrFiles := map[string]string{"alpha.txt": "alpha v1", "gamma.txt": "gamma is new"}
	incr := vaultTestRun(t, primary, src, incrFiles, full)
	if refs := referencedKeys(incr); len(refs) != 1 || refs[0] != full.Files[0].BackupPath {
		t.Fatalf("control: the third run must reference the first run's alpha, got %v", refs)
	}
	var gammaKey string
	for _, f := range incr.Files {
		if f.BackupPath != "" && !isReferenceEntry(f, incr.ID) {
			gammaKey = f.BackupPath
		}
	}

	vaultDir := privateStoreTempDir(t)
	vm, err := NewVaultManager(VaultConfig{VaultPath: vaultDir, RetentionCount: 5, Enabled: true}, primary)
	if err != nil {
		t.Fatal(err)
	}
	snaps, err := ListSnapshots(primary)
	if err != nil || len(snaps) != 3 {
		t.Fatalf("control: primary snapshots = %d, %v", len(snaps), err)
	}
	for _, snap := range snaps[:2] {
		if _, err := vm.SyncSnapshot(snap.ID); err != nil {
			t.Fatal(err)
		}
	}

	blocking := &blockingDownloadProvider{LocalProvider: primary, key: gammaKey, entered: make(chan struct{}), release: make(chan struct{})}
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(blocking.release) }) }
	defer release()
	syncDone := make(chan error, 1)
	go func() {
		_, err := vm.SyncAfterBackupFrom(blocking, incr.ID)
		syncDone <- err
	}()
	<-blocking.entered

	other, err := NewVaultManager(VaultConfig{VaultPath: vaultDir, RetentionCount: 1, Enabled: true}, primary)
	if err != nil {
		t.Fatal(err)
	}
	retentionDone := make(chan error, 1)
	go func() { retentionDone <- other.EnforceRetention() }()
	select {
	case err := <-retentionDone:
		release()
		t.Logf("sync after the early retention: %v", <-syncDone)
		t.Fatalf("retention ran while a sync was copying (err=%v)", err)
	case <-time.After(300 * time.Millisecond):
	}
	release()
	if err := <-syncDone; err != nil {
		t.Fatalf("sync failed: %v", err)
	}
	if err := <-retentionDone; err != nil {
		t.Fatalf("retention failed: %v", err)
	}
	vaultProvider := privateTestLocalProvider(t, vaultDir)
	if got := restoreVaultSnapshot(t, vaultProvider, incr.ID); !reflect.DeepEqual(got, incrFiles) {
		t.Fatalf("restore of the synced snapshot = %v, want %v", got, incrFiles)
	}
}

// A dropped manifest that names an object under a kept snapshot's own
// prefix (not referenced by the kept manifest's files, e.g. its system
// state) must never delete it.
func TestVaultRetention_NeverDeletesUnderAKeptSnapshotPrefix(t *testing.T) {
	primaryDir := t.TempDir()
	primary := privateTestLocalProvider(t, primaryDir)
	src := t.TempDir()
	kept := vaultTestRun(t, primary, src, map[string]string{"alpha.txt": "alpha bytes"}, nil)
	keptState := path.Join(snapshotRootDir, kept.ID, systemStateDir, "registry", "SYSTEM")
	stateFile := filepath.Join(t.TempDir(), "SYSTEM")
	if err := os.WriteFile(stateFile, []byte("hive bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := primary.Upload(stateFile, keptState); err != nil {
		t.Fatal(err)
	}
	// An older snapshot whose manifest names that object.
	olderID := "snap-older"
	writeFidelityManifest(t, primaryDir, olderID, Snapshot{
		ID:        olderID,
		Timestamp: kept.Timestamp.Add(-time.Hour),
		Files:     []SnapshotFile{{SourcePath: "/src/state", BackupPath: keptState, Size: 10}},
		Size:      10,
	})

	vm, vault := newVaultTestManager(t, primary, 1)
	if _, err := vm.SyncSnapshot(olderID); err != nil {
		t.Fatal(err)
	}
	if _, err := vm.SyncAfterBackupFrom(primary, kept.ID); err != nil {
		t.Fatalf("sync + retention failed: %v", err)
	}
	if vaultHas(t, vault, path.Join(snapshotRootDir, olderID, snapshotManifestKey)) {
		t.Fatal("control: retention must drop the older snapshot")
	}
	if !vaultHas(t, vault, keptState) {
		t.Fatalf("retention deleted %s, which lies under the kept snapshot's own prefix", keptState)
	}
}

// failListProvider fails List for every prefix under one snapshot.
type failListProvider struct {
	*providers.LocalProvider
	failPrefix string
}

func (p *failListProvider) List(prefix string) ([]string, error) {
	if strings.HasPrefix(prefix, p.failPrefix) {
		return nil, errors.New("injected list failure")
	}
	return p.LocalProvider.List(prefix)
}

// When the vault listing of a prefix fails, its objects are copied again; a
// sync that then fails must not delete them, since they may already have
// been in the vault for a complete snapshot.
func TestVaultSync_FailedSyncNeverDeletesObjectsItCouldNotProveAbsent(t *testing.T) {
	primary := privateTestLocalProvider(t, t.TempDir())
	src := t.TempDir()
	files := map[string]string{"alpha.txt": "alpha bytes", "beta.txt": "beta bytes"}
	full := vaultTestRun(t, primary, src, files, nil)
	incr := vaultTestRun(t, primary, src, files, full)
	if len(referencedKeys(incr)) != 2 {
		t.Fatalf("control: the second run must reference both files, got %v", referencedKeys(incr))
	}
	vm, vault := newVaultTestManager(t, primary, 5)
	if _, err := vm.SyncSnapshot(full.ID); err != nil {
		t.Fatal(err)
	}
	// beta is now gone from primary, so the sync of incr fails after it
	// re-copies alpha (its prefix could not be listed).
	var alphaKey, betaKey string
	for _, f := range full.Files {
		if strings.Contains(f.BackupPath, "alpha") {
			alphaKey = f.BackupPath
		} else {
			betaKey = f.BackupPath
		}
	}
	if err := primary.Delete(betaKey); err != nil {
		t.Fatal(err)
	}
	vm.vault = &failListProvider{LocalProvider: vault, failPrefix: path.Join(snapshotRootDir, full.ID)}
	if _, err := vm.SyncSnapshot(incr.ID); err == nil {
		t.Fatal("control: the sync must fail on the missing beta")
	}
	vm.vault = vault
	if !vaultHas(t, vault, alphaKey) {
		t.Fatalf("the failed sync deleted %s, which the earlier vault snapshot holds", alphaKey)
	}
	if got := restoreVaultSnapshot(t, vault, full.ID); !reflect.DeepEqual(got, files) {
		t.Fatalf("restore of the earlier vault snapshot = %v, want %v", got, files)
	}
}
