package backup

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

type recordingTestRestoreProvider struct {
	manifest  []byte
	files     map[string][]byte
	downloads map[string]string
}

func (p *recordingTestRestoreProvider) Upload(localPath, remotePath string) error {
	return nil
}

func (p *recordingTestRestoreProvider) Download(remotePath, localPath string) error {
	if remotePath == path.Join(snapshotRootDir, "dup-basenames", snapshotManifestKey) {
		if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
			return err
		}
		return os.WriteFile(localPath, p.manifest, 0o644)
	}
	data, ok := p.files[remotePath]
	if !ok {
		return os.ErrNotExist
	}
	if p.downloads == nil {
		p.downloads = make(map[string]string)
	}
	p.downloads[remotePath] = localPath
	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(localPath, data, 0o644)
}

func (p *recordingTestRestoreProvider) List(prefix string) ([]string, error) {
	return nil, nil
}

func (p *recordingTestRestoreProvider) Delete(remotePath string) error {
	return nil
}

func setupTestSnapshot(t *testing.T, basePath string) string {
	t.Helper()
	snapshotID := "snapshot-test-001"
	prefix := path.Join("snapshots", snapshotID)

	// Create a file to back up
	srcDir := t.TempDir()
	srcFile := filepath.Join(srcDir, "hello.txt")
	if err := os.WriteFile(srcFile, []byte("hello world"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Upload it through the provider (creates .gz)
	provider := providers.NewLocalProvider(basePath)
	backupPath := path.Join(prefix, "files", "hello.txt.gz")
	if err := provider.Upload(srcFile, backupPath); err != nil {
		t.Fatal(err)
	}

	// Write manifest
	manifest := Snapshot{
		ID: snapshotID,
		Files: []SnapshotFile{
			{SourcePath: srcFile, BackupPath: backupPath, Size: 11},
		},
		Size: 11,
	}
	manifestBytes, _ := json.Marshal(manifest)
	manifestPath := filepath.Join(basePath, prefix, "manifest.json")
	if err := os.MkdirAll(filepath.Dir(manifestPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, manifestBytes, 0o644); err != nil {
		t.Fatal(err)
	}

	return snapshotID
}

func TestVerifyIntegrity_AllPass(t *testing.T) {
	basePath := t.TempDir()
	snapshotID := setupTestSnapshot(t, basePath)
	provider := providers.NewLocalProvider(basePath)

	result, err := VerifyIntegrity(provider, snapshotID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "passed" {
		t.Errorf("expected passed, got %s (error: %s)", result.Status, result.Error)
	}
	if result.FilesVerified != 1 {
		t.Errorf("expected 1 file verified, got %d", result.FilesVerified)
	}
	if result.FilesFailed != 0 {
		t.Errorf("expected 0 files failed, got %d", result.FilesFailed)
	}
}

func TestVerifyIntegrity_MissingManifest(t *testing.T) {
	basePath := t.TempDir()
	provider := providers.NewLocalProvider(basePath)

	result, err := VerifyIntegrity(provider, "nonexistent-snapshot")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}
}

func TestVerifyIntegrity_MissingFile(t *testing.T) {
	basePath := t.TempDir()
	snapshotID := "snapshot-missing-file"
	prefix := path.Join("snapshots", snapshotID)

	// Write manifest referencing a file that doesn't exist
	manifest := Snapshot{
		ID: snapshotID,
		Files: []SnapshotFile{
			{SourcePath: "/tmp/gone.txt", BackupPath: path.Join(prefix, "files", "gone.txt.gz"), Size: 10},
		},
		Size: 10,
	}
	manifestBytes, _ := json.Marshal(manifest)
	manifestDir := filepath.Join(basePath, prefix)
	os.MkdirAll(manifestDir, 0o755)
	os.WriteFile(filepath.Join(manifestDir, "manifest.json"), manifestBytes, 0o644)

	provider := providers.NewLocalProvider(basePath)
	result, err := VerifyIntegrity(provider, snapshotID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}
	if result.FilesFailed != 1 {
		t.Errorf("expected 1 file failed, got %d", result.FilesFailed)
	}
}

func TestVerifyIntegrity_CorruptedGzip(t *testing.T) {
	basePath := t.TempDir()
	snapshotID := "snapshot-corrupt"
	prefix := path.Join("snapshots", snapshotID)

	// Write corrupt .gz file directly (bypass provider)
	gzPath := filepath.Join(basePath, prefix, "files", "bad.txt.gz")
	os.MkdirAll(filepath.Dir(gzPath), 0o755)
	os.WriteFile(gzPath, []byte("not valid gzip data"), 0o644)

	manifest := Snapshot{
		ID: snapshotID,
		Files: []SnapshotFile{
			{SourcePath: "/tmp/bad.txt", BackupPath: path.Join(prefix, "files", "bad.txt.gz"), Size: 5},
		},
		Size: 5,
	}
	manifestBytes, _ := json.Marshal(manifest)
	manifestDir := filepath.Join(basePath, prefix)
	os.WriteFile(filepath.Join(manifestDir, "manifest.json"), manifestBytes, 0o644)

	provider := providers.NewLocalProvider(basePath)
	result, err := VerifyIntegrity(provider, snapshotID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}
	if result.FilesFailed != 1 {
		t.Errorf("expected 1 file failed, got %d", result.FilesFailed)
	}
}

func TestTestRestore_HappyPath(t *testing.T) {
	basePath := t.TempDir()
	snapshotID := setupTestSnapshot(t, basePath)
	provider := providers.NewLocalProvider(basePath)

	var progressCalls int
	progressFn := func(current, total int) { progressCalls++ }

	result, err := TestRestore(provider, snapshotID, progressFn)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "passed" {
		t.Errorf("expected passed, got %s (error: %s)", result.Status, result.Error)
	}
	if result.FilesVerified != 1 {
		t.Errorf("expected 1 file verified, got %d", result.FilesVerified)
	}
	if result.RestoreTimeSeconds < 0 {
		t.Error("restore time should be non-negative")
	}
	if !result.CleanedUp {
		t.Error("expected cleanup to succeed")
	}
	if progressCalls != 1 {
		t.Errorf("expected 1 progress call, got %d", progressCalls)
	}
	// Verify temp dir was removed
	if _, err := os.Stat(result.RestorePath); !os.IsNotExist(err) {
		t.Error("restore path should have been cleaned up")
	}
}

func TestTestRestore_MissingFile(t *testing.T) {
	basePath := t.TempDir()
	snapshotID := "snapshot-restore-missing"
	prefix := path.Join("snapshots", snapshotID)

	manifest := Snapshot{
		ID: snapshotID,
		Files: []SnapshotFile{
			{SourcePath: "/tmp/gone.txt", BackupPath: path.Join(prefix, "files", "gone.txt.gz"), Size: 10},
		},
		Size: 10,
	}
	manifestBytes, _ := json.Marshal(manifest)
	manifestDir := filepath.Join(basePath, prefix)
	os.MkdirAll(manifestDir, 0o755)
	os.WriteFile(filepath.Join(manifestDir, "manifest.json"), manifestBytes, 0o644)

	provider := providers.NewLocalProvider(basePath)
	result, err := TestRestore(provider, snapshotID, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}
}

func TestCleanupRestoreDir_Success(t *testing.T) {
	dir := filepath.Join(os.TempDir(), "breeze-restore-test", "test-cleanup")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "dummy.txt"), []byte("x"), 0o644)

	if err := CleanupRestoreDir(dir); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error("directory should have been removed")
	}
}

func TestCleanupRestoreDir_PathTraversal(t *testing.T) {
	err := CleanupRestoreDir("/etc/passwd")
	if err == nil {
		t.Error("expected error for path outside restore prefix")
	}
}

func TestTestRestorePreservesDistinctPathsForDuplicateBasenames(t *testing.T) {
	snapshot := Snapshot{
		ID: "dup-basenames",
		Files: []SnapshotFile{
			{SourcePath: "/var/log/app/config.json", BackupPath: path.Join(snapshotRootDir, "dup-basenames", "files", "a-config.json.gz"), Size: 2},
			{SourcePath: "/etc/app/config.json", BackupPath: path.Join(snapshotRootDir, "dup-basenames", "files", "b-config.json.gz"), Size: 2},
		},
		Size: 4,
	}
	manifest, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}

	provider := &recordingTestRestoreProvider{
		manifest: manifest,
		files: map[string][]byte{
			path.Join(snapshotRootDir, "dup-basenames", "files", "a-config.json.gz"): []byte("aa"),
			path.Join(snapshotRootDir, "dup-basenames", "files", "b-config.json.gz"): []byte("bb"),
		},
	}

	result, err := TestRestore(provider, "dup-basenames", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "passed" {
		t.Fatalf("expected passed, got %s", result.Status)
	}

	pathA := provider.downloads[path.Join(snapshotRootDir, "dup-basenames", "files", "a-config.json.gz")]
	pathB := provider.downloads[path.Join(snapshotRootDir, "dup-basenames", "files", "b-config.json.gz")]
	if pathA == "" || pathB == "" {
		t.Fatalf("expected both file downloads to be recorded, got %+v", provider.downloads)
	}
	if pathA == pathB {
		t.Fatalf("duplicate basenames restored to the same path %q", pathA)
	}
}
