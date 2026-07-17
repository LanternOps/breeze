package backup

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// writeFidelityManifest writes a manifest.json for snapshotID under basePath.
func writeFidelityManifest(t *testing.T, basePath, snapshotID string, manifest Snapshot) {
	t.Helper()
	prefix := path.Join(snapshotRootDir, snapshotID)
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(basePath, prefix)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, snapshotManifestKey), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// uploadFidelityObject uploads content as the snapshot object and returns its
// backupPath. The LocalProvider gzips on upload / gunzips on download, so a
// verify downloads the original bytes back.
func uploadFidelityObject(t *testing.T, provider *providers.LocalProvider, snapshotID, name, content string) string {
	t.Helper()
	srcDir := t.TempDir()
	srcFile := filepath.Join(srcDir, name)
	if err := os.WriteFile(srcFile, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	backupPath := path.Join(snapshotRootDir, snapshotID, snapshotFilesDir, name+".gz")
	if err := provider.Upload(srcFile, backupPath); err != nil {
		t.Fatal(err)
	}
	return backupPath
}

// U11: a checksum that doesn't match the stored bytes must FAIL integrity —
// this is the corruption case that previously passed (verify only checked
// presence, never content).
func TestVerifyIntegrity_ChecksumMismatchFails(t *testing.T) {
	basePath := t.TempDir()
	provider := providers.NewLocalProvider(basePath)
	snapshotID := "snap-cksum-mismatch"
	backupPath := uploadFidelityObject(t, provider, snapshotID, "a.txt", "hello world")

	writeFidelityManifest(t, basePath, snapshotID, Snapshot{
		ID: snapshotID,
		Files: []SnapshotFile{{
			SourcePath: "/src/a.txt",
			BackupPath: backupPath,
			Size:       11, // correct size, so only the checksum catches it
			Checksum:   "0000000000000000000000000000000000000000000000000000000000000000",
		}},
		Size: 11,
	})

	result, err := VerifyIntegrity(provider, snapshotID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "failed" {
		t.Errorf("expected failed on checksum mismatch, got %s", result.Status)
	}
	if result.FilesFailed != 1 {
		t.Errorf("expected 1 file failed, got %d", result.FilesFailed)
	}
}

// U11: a size that doesn't match must FAIL (catches truncation / the live
// 59-vs-39-byte corruption class even on old manifests with no checksum).
func TestVerifyIntegrity_SizeMismatchFails(t *testing.T) {
	basePath := t.TempDir()
	provider := providers.NewLocalProvider(basePath)
	snapshotID := "snap-size-mismatch"
	backupPath := uploadFidelityObject(t, provider, snapshotID, "b.txt", "hello world")

	writeFidelityManifest(t, basePath, snapshotID, Snapshot{
		ID:    snapshotID,
		Files: []SnapshotFile{{SourcePath: "/src/b.txt", BackupPath: backupPath, Size: 999}}, // wrong size, no checksum
		Size:  999,
	})

	result, err := VerifyIntegrity(provider, snapshotID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "failed" {
		t.Errorf("expected failed on size mismatch, got %s", result.Status)
	}
}

// Backward-compat: a manifest with no checksum but a correct size still passes
// (pre-checksum snapshots must remain verifiable).
func TestVerifyIntegrity_NoChecksumCorrectSizePasses(t *testing.T) {
	basePath := t.TempDir()
	provider := providers.NewLocalProvider(basePath)
	snapshotID := "snap-legacy-ok"
	backupPath := uploadFidelityObject(t, provider, snapshotID, "c.txt", "hello world")

	writeFidelityManifest(t, basePath, snapshotID, Snapshot{
		ID:    snapshotID,
		Files: []SnapshotFile{{SourcePath: "/src/c.txt", BackupPath: backupPath, Size: 11}}, // no checksum
		Size:  11,
	})

	result, err := VerifyIntegrity(provider, snapshotID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "passed" {
		t.Errorf("legacy (no-checksum) snapshot should pass, got %s (%s)", result.Status, result.Error)
	}
	// A size-only verification must be observable, not silently reported as a
	// full checksum verification.
	if result.FilesSizeOnly != 1 {
		t.Errorf("expected FilesSizeOnly=1 for a no-checksum manifest, got %d", result.FilesSizeOnly)
	}
}

// A multi-file snapshot with one good + one corrupt file must report "partial",
// not "passed" — a partially-corrupt backup reported as fully good is a
// silent-data-loss reporting bug.
func TestVerifyIntegrity_PartialOnMixedFiles(t *testing.T) {
	basePath := t.TempDir()
	provider := providers.NewLocalProvider(basePath)
	snapshotID := "snap-partial"
	good := uploadFidelityObject(t, provider, snapshotID, "good.txt", "hello world")
	bad := uploadFidelityObject(t, provider, snapshotID, "bad.txt", "hello world")

	writeFidelityManifest(t, basePath, snapshotID, Snapshot{
		ID: snapshotID,
		Files: []SnapshotFile{
			{SourcePath: "/src/good.txt", BackupPath: good, Size: 11}, // size-only, matches
			{SourcePath: "/src/bad.txt", BackupPath: bad, Size: 11,
				Checksum: "0000000000000000000000000000000000000000000000000000000000000000"}, // wrong checksum
		},
		Size: 22,
	})

	result, err := VerifyIntegrity(provider, snapshotID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "partial" {
		t.Errorf("expected partial, got %s", result.Status)
	}
	if result.FilesVerified != 1 || result.FilesFailed != 1 {
		t.Errorf("expected 1 verified + 1 failed, got %d/%d", result.FilesVerified, result.FilesFailed)
	}
}

// U11 for the TestRestore path: it shares VerifyIntegrity's corruption-detection
// logic, so it must also fail on a checksum mismatch (correct size).
func TestTestRestore_ChecksumMismatchFails(t *testing.T) {
	basePath := t.TempDir()
	provider := providers.NewLocalProvider(basePath)
	snapshotID := "snap-tr-cksum"
	backupPath := uploadFidelityObject(t, provider, snapshotID, "a.txt", "hello world")

	writeFidelityManifest(t, basePath, snapshotID, Snapshot{
		ID: snapshotID,
		Files: []SnapshotFile{{SourcePath: "/src/a.txt", BackupPath: backupPath, Size: 11,
			Checksum: "0000000000000000000000000000000000000000000000000000000000000000"}},
		Size: 11,
	})

	result, err := TestRestore(provider, snapshotID, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "failed" || result.FilesFailed != 1 {
		t.Errorf("expected failed/1, got %s/%d", result.Status, result.FilesFailed)
	}
}

// TestRestore must also fail on a size mismatch (catches truncation on legacy
// no-checksum manifests).
func TestTestRestore_SizeMismatchFails(t *testing.T) {
	basePath := t.TempDir()
	provider := providers.NewLocalProvider(basePath)
	snapshotID := "snap-tr-size"
	backupPath := uploadFidelityObject(t, provider, snapshotID, "b.txt", "hello world")

	writeFidelityManifest(t, basePath, snapshotID, Snapshot{
		ID:    snapshotID,
		Files: []SnapshotFile{{SourcePath: "/src/b.txt", BackupPath: backupPath, Size: 999}},
		Size:  999,
	})

	result, err := TestRestore(provider, snapshotID, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}
}

// The REAL restore path (writes actual user data) must reject a corrupt object,
// not silently report it "restored".
func TestRestoreFromSnapshot_ChecksumMismatchFails(t *testing.T) {
	basePath := t.TempDir()
	provider := providers.NewLocalProvider(basePath)
	snapshotID := "snap-restore-cksum"
	backupPath := uploadFidelityObject(t, provider, snapshotID, "a.txt", "hello world")

	writeFidelityManifest(t, basePath, snapshotID, Snapshot{
		ID: snapshotID,
		Files: []SnapshotFile{{SourcePath: "/src/a.txt", BackupPath: backupPath, Size: 11,
			Checksum: "0000000000000000000000000000000000000000000000000000000000000000"}},
		Size: 11,
	})

	targetDir := t.TempDir()
	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: targetDir}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "failed" || result.FilesFailed != 1 {
		t.Errorf("expected failed/1, got %s/%d", result.Status, result.FilesFailed)
	}
	if result.FilesRestored != 0 {
		t.Errorf("corrupt file must not count as restored, got FilesRestored=%d", result.FilesRestored)
	}
	if len(result.Warnings) == 0 {
		t.Error("expected a warning describing the failed checksum")
	}
}

// Backward-compat: a manifest with Mode==0 (older manifest, or a 0000-perm file)
// must restore cleanly and NOT be chmod'd to 0000.
func TestRestoreFromSnapshot_Mode0LeavesDefault(t *testing.T) {
	basePath := t.TempDir()
	provider := providers.NewLocalProvider(basePath)

	srcDir := t.TempDir()
	srcFile := filepath.Join(srcDir, "legacy.txt")
	if err := os.WriteFile(srcFile, []byte("legacy content"), 0o644); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(srcFile)
	// mode: 0 → manifest Mode omitted → restore must leave OS default, not 0000.
	snap, err := CreateSnapshot(provider, []backupFile{{
		sourcePath: srcFile, snapshotPath: "path_0/legacy.txt",
		size: info.Size(), modTime: info.ModTime(), mode: 0,
	}})
	if err != nil {
		t.Fatalf("CreateSnapshot: %v", err)
	}
	if snap.Files[0].Mode != 0 {
		t.Fatalf("expected Mode 0 in manifest, got %o", snap.Files[0].Mode)
	}

	targetDir := t.TempDir()
	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snap.ID, TargetPath: targetDir}, nil)
	if err != nil {
		t.Fatalf("RestoreFromSnapshot: %v", err)
	}
	if result.Status != "completed" {
		t.Fatalf("restore status = %s (%v)", result.Status, result.FailedFiles)
	}
	restored := resolveTargetPath(targetDir, srcFile)
	ri, err := os.Stat(restored)
	if err != nil {
		t.Fatalf("stat restored: %v", err)
	}
	if ri.Mode().Perm() == 0 {
		t.Error("Mode==0 manifest must NOT chmod the restored file to 0000")
	}
}

// The collector is the source of the mode that ends up in the manifest; assert
// it end-to-end so a regression dropping `mode:` from collectBackupFilesFromPaths
// can't ship green.
func TestCollectBackupFiles_CapturesMode(t *testing.T) {
	srcDir := t.TempDir()
	srcFile := filepath.Join(srcDir, "m.txt")
	if err := os.WriteFile(srcFile, []byte("x"), 0o640); err != nil {
		t.Fatal(err)
	}
	mgr := NewBackupManager(BackupConfig{Paths: []string{srcFile}})
	files, err := mgr.collectBackupFiles()
	if err != nil {
		t.Fatalf("collectBackupFiles: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("expected 1 file, got %d", len(files))
	}
	if files[0].mode.Perm() != 0o640 {
		t.Errorf("expected captured mode 0640, got %o", files[0].mode.Perm())
	}
}

// Roundtrip: CreateSnapshot records a real checksum + mode, and a clean verify
// passes against it (proves the write side and read side agree).
func TestCreateSnapshot_RecordsChecksumAndMode_VerifyPasses(t *testing.T) {
	basePath := t.TempDir()
	provider := providers.NewLocalProvider(basePath)

	srcDir := t.TempDir()
	srcFile := filepath.Join(srcDir, "r.txt")
	content := "roundtrip content"
	if err := os.WriteFile(srcFile, []byte(content), 0o640); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(srcFile)
	if err != nil {
		t.Fatal(err)
	}

	snap, err := CreateSnapshot(provider, []backupFile{{
		sourcePath:   srcFile,
		snapshotPath: "path_0/r.txt",
		size:         info.Size(),
		modTime:      info.ModTime(),
		mode:         info.Mode(),
	}})
	if err != nil {
		t.Fatalf("CreateSnapshot: %v", err)
	}
	if snap.Files[0].Checksum == "" {
		t.Error("expected a checksum in the manifest")
	}
	if snap.Files[0].Mode != 0o640 {
		t.Errorf("expected mode 0640 captured, got %o", snap.Files[0].Mode)
	}

	result, err := VerifyIntegrity(provider, snap.ID)
	if err != nil {
		t.Fatalf("VerifyIntegrity: %v", err)
	}
	if result.Status != "passed" {
		t.Errorf("clean roundtrip verify should pass, got %s (%s)", result.Status, result.Error)
	}
}

// U9: restore reapplies the original Unix mode and mtime.
func TestRestoreFromSnapshot_ReappliesModeAndMtime(t *testing.T) {
	basePath := t.TempDir()
	provider := providers.NewLocalProvider(basePath)

	srcDir := t.TempDir()
	srcFile := filepath.Join(srcDir, "exec.sh")
	if err := os.WriteFile(srcFile, []byte("#!/bin/sh\necho hi\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	wantMtime := time.Now().Add(-48 * time.Hour).Truncate(time.Second)
	if err := os.Chtimes(srcFile, wantMtime, wantMtime); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(srcFile)
	if err != nil {
		t.Fatal(err)
	}

	snap, err := CreateSnapshot(provider, []backupFile{{
		sourcePath:   srcFile,
		snapshotPath: "path_0/exec.sh",
		size:         info.Size(),
		modTime:      info.ModTime(),
		mode:         info.Mode(),
	}})
	if err != nil {
		t.Fatalf("CreateSnapshot: %v", err)
	}

	targetDir := t.TempDir()
	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snap.ID, TargetPath: targetDir}, nil)
	if err != nil {
		t.Fatalf("RestoreFromSnapshot: %v", err)
	}
	if result.Status != "completed" {
		t.Fatalf("restore status = %s (%v)", result.Status, result.FailedFiles)
	}

	restored := resolveTargetPath(targetDir, srcFile)
	ri, err := os.Stat(restored)
	if err != nil {
		t.Fatalf("stat restored file: %v", err)
	}
	if ri.Mode().Perm() != 0o700 {
		t.Errorf("mode not preserved on restore: got %o, want 0700", ri.Mode().Perm())
	}
	if !ri.ModTime().Truncate(time.Second).Equal(wantMtime) {
		t.Errorf("mtime not preserved on restore: got %v, want %v", ri.ModTime(), wantMtime)
	}
}
