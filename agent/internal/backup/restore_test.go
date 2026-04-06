package backup

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

type flakyDownloadProvider struct {
	*providers.LocalProvider
	mu         sync.Mutex
	failOnce   string
	callCounts map[string]int
}

func (p *flakyDownloadProvider) Download(remotePath, localPath string) error {
	p.mu.Lock()
	p.callCounts[remotePath]++
	callCount := p.callCounts[remotePath]
	fail := remotePath == p.failOnce && callCount == 1
	p.mu.Unlock()

	if fail {
		return errors.New("injected download failure")
	}
	return p.LocalProvider.Download(remotePath, localPath)
}

// setupRestoreTestSnapshot creates a local provider with a test snapshot containing
// compressed files and a manifest. Returns the provider, snapshot ID, and
// a cleanup function.
func setupRestoreTestSnapshot(t *testing.T, files map[string]string) (*providers.LocalProvider, string) {
	t.Helper()

	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)

	snapshotID := "test-snap-001"
	prefix := filepath.Join("snapshots", snapshotID)

	// Create source files and upload them (provider compresses .gz files)
	var snapshotFiles []SnapshotFile
	for name, content := range files {
		// Write source file
		srcDir := t.TempDir()
		srcPath := filepath.Join(srcDir, name)
		if err := os.MkdirAll(filepath.Dir(srcPath), 0o755); err != nil {
			t.Fatalf("create src dir: %v", err)
		}
		if err := os.WriteFile(srcPath, []byte(content), 0o644); err != nil {
			t.Fatalf("write src file: %v", err)
		}

		backupPath := filepath.Join(prefix, "files", name+".gz")
		if err := provider.Upload(srcPath, backupPath); err != nil {
			t.Fatalf("upload %s: %v", name, err)
		}

		snapshotFiles = append(snapshotFiles, SnapshotFile{
			SourcePath: filepath.Join("/original", name),
			BackupPath: filepath.ToSlash(backupPath),
			Size:       int64(len(content)),
			ModTime:    time.Now().UTC(),
		})
	}

	// Write manifest
	snapshot := Snapshot{
		ID:        snapshotID,
		Timestamp: time.Now().UTC(),
		Files:     snapshotFiles,
		Size:      totalSize(snapshotFiles),
	}
	manifestData, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}

	manifestTmp := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(manifestTmp, manifestData, 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	manifestKey := filepath.Join(prefix, "manifest.json")
	if err := provider.Upload(manifestTmp, manifestKey); err != nil {
		t.Fatalf("upload manifest: %v", err)
	}

	return provider, snapshotID
}

func totalSize(files []SnapshotFile) int64 {
	var s int64
	for _, f := range files {
		s += f.Size
	}
	return s
}

func TestRestoreFromSnapshot_HappyPath(t *testing.T) {
	testFiles := map[string]string{
		"config.txt": "key=value\n",
		"data.csv":   "a,b,c\n1,2,3\n",
	}
	provider, snapID := setupRestoreTestSnapshot(t, testFiles)

	targetDir := t.TempDir()

	cfg := RestoreConfig{
		SnapshotID: snapID,
		TargetPath: targetDir,
	}

	var progressCalls int
	progressFn := func(phase string, current, total int64, message string) {
		progressCalls++
	}

	result, err := RestoreFromSnapshot(provider, cfg, progressFn)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if result.Status != "completed" {
		t.Errorf("expected status completed, got %s", result.Status)
	}
	if result.FilesRestored != 2 {
		t.Errorf("expected 2 files restored, got %d", result.FilesRestored)
	}
	if result.FilesFailed != 0 {
		t.Errorf("expected 0 files failed, got %d", result.FilesFailed)
	}
	if result.BytesRestored <= 0 {
		t.Errorf("expected positive bytes restored, got %d", result.BytesRestored)
	}
	if progressCalls < 2 {
		t.Errorf("expected at least 2 progress calls, got %d", progressCalls)
	}

	// Verify files exist in target (directory structure is preserved)
	var fileCount int
	walkErr := filepath.Walk(targetDir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			fileCount++
		}
		return nil
	})
	if walkErr != nil {
		t.Fatalf("walk target dir: %v", walkErr)
	}
	if fileCount != 2 {
		t.Errorf("expected 2 files in target, got %d", fileCount)
	}
}

func TestRestoreFromSnapshot_CancelledMidway(t *testing.T) {
	testFiles := map[string]string{
		"one.txt": "first\n",
		"two.txt": "second\n",
	}
	provider, snapID := setupRestoreTestSnapshot(t, testFiles)

	targetDir := t.TempDir()
	cfg := RestoreConfig{
		SnapshotID: snapID,
		TargetPath: targetDir,
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	progressCalls := 0
	progressFn := func(phase string, current, total int64, message string) {
		progressCalls++
		if progressCalls == 2 {
			cancel()
		}
	}

	result, err := RestoreFromSnapshotContext(ctx, provider, cfg, progressFn)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "partial" {
		t.Fatalf("status = %q, want partial", result.Status)
	}
	if result.FilesRestored != 1 {
		t.Fatalf("FilesRestored = %d, want 1", result.FilesRestored)
	}
	if result.Error == "" {
		t.Fatal("expected cancellation error to be recorded")
	}
}

func TestRestoreFromSnapshot_SelectivePaths(t *testing.T) {
	testFiles := map[string]string{
		"config.txt":  "key=value\n",
		"data.csv":    "a,b,c\n",
		"secrets.txt": "do not restore\n",
	}
	provider, snapID := setupRestoreTestSnapshot(t, testFiles)

	targetDir := t.TempDir()

	cfg := RestoreConfig{
		SnapshotID:    snapID,
		TargetPath:    targetDir,
		SelectedPaths: []string{"/original/config", "/original/data"},
	}

	result, err := RestoreFromSnapshot(provider, cfg, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if result.Status != "completed" {
		t.Errorf("expected status completed, got %s", result.Status)
	}
	if result.FilesRestored != 2 {
		t.Errorf("expected 2 files restored (config + data), got %d", result.FilesRestored)
	}

	// Verify secrets.txt was not restored
	entries, err := os.ReadDir(targetDir)
	if err != nil {
		t.Fatalf("read target dir: %v", err)
	}
	for _, e := range entries {
		if e.Name() == "secrets.txt" {
			t.Error("secrets.txt should not have been restored")
		}
	}
}

func TestRestoreFromSnapshot_Resume(t *testing.T) {
	testFiles := map[string]string{
		"file1.txt": "content1\n",
		"file2.txt": "content2\n",
	}
	baseProvider, snapID := setupRestoreTestSnapshot(t, testFiles)
	snapshot, err := downloadManifest(baseProvider, snapID)
	if err != nil {
		t.Fatalf("download manifest: %v", err)
	}
	if len(snapshot.Files) != 2 {
		t.Fatalf("expected 2 files in snapshot, got %d", len(snapshot.Files))
	}

	provider := &flakyDownloadProvider{
		LocalProvider: baseProvider,
		failOnce:      snapshot.Files[1].BackupPath,
		callCounts:    make(map[string]int),
	}

	targetDir := t.TempDir()
	cfg := RestoreConfig{
		SnapshotID: snapID,
		TargetPath: targetDir,
	}

	result1, err := RestoreFromSnapshot(provider, cfg, nil)
	if err != nil {
		t.Fatalf("first restore unexpected error: %v", err)
	}
	if result1.Status != "partial" {
		t.Errorf("first restore: expected partial, got %s", result1.Status)
	}
	if result1.FilesRestored != 1 {
		t.Errorf("first restore: expected 1 file restored, got %d", result1.FilesRestored)
	}
	if result1.StagingDir == "" {
		t.Fatal("first restore should retain staging dir for resume")
	}

	result2, err := RestoreFromSnapshot(provider, cfg, nil)
	if err != nil {
		t.Fatalf("second restore unexpected error: %v", err)
	}
	if result2.Status != "completed" {
		t.Errorf("second restore: expected completed, got %s", result2.Status)
	}
	if result2.FilesRestored != 2 {
		t.Errorf("second restore: expected 2 files restored, got %d", result2.FilesRestored)
	}

	if provider.callCounts[snapshot.Files[0].BackupPath] != 1 {
		t.Errorf("first file downloaded %d times, want 1", provider.callCounts[snapshot.Files[0].BackupPath])
	}
	if provider.callCounts[snapshot.Files[1].BackupPath] != 2 {
		t.Errorf("second file downloaded %d times, want 2", provider.callCounts[snapshot.Files[1].BackupPath])
	}

	if _, err := os.Stat(result1.StagingDir); !os.IsNotExist(err) {
		t.Errorf("expected staging dir %q to be removed after successful resume", result1.StagingDir)
	}
}

func TestRestoreFromSnapshot_ResumeRedownloadsMissingCompletedFile(t *testing.T) {
	testFiles := map[string]string{
		"file1.txt": "content1\n",
		"file2.txt": "content2\n",
	}
	baseProvider, snapID := setupRestoreTestSnapshot(t, testFiles)
	snapshot, err := downloadManifest(baseProvider, snapID)
	if err != nil {
		t.Fatalf("download manifest: %v", err)
	}

	provider := &flakyDownloadProvider{
		LocalProvider: baseProvider,
		failOnce:      snapshot.Files[1].BackupPath,
		callCounts:    make(map[string]int),
	}

	targetDir := t.TempDir()
	cfg := RestoreConfig{
		SnapshotID: snapID,
		TargetPath: targetDir,
	}

	result1, err := RestoreFromSnapshot(provider, cfg, nil)
	if err != nil {
		t.Fatalf("first restore unexpected error: %v", err)
	}
	if result1.Status != "partial" {
		t.Fatalf("first restore: expected partial, got %s", result1.Status)
	}

	firstTarget := resolveTargetPath(targetDir, snapshot.Files[0].SourcePath)
	if err := os.Remove(firstTarget); err != nil {
		t.Fatalf("remove restored file: %v", err)
	}

	result2, err := RestoreFromSnapshot(provider, cfg, nil)
	if err != nil {
		t.Fatalf("second restore unexpected error: %v", err)
	}
	if result2.Status != "completed" {
		t.Fatalf("second restore: expected completed, got %s", result2.Status)
	}
	if provider.callCounts[snapshot.Files[0].BackupPath] != 2 {
		t.Fatalf("first file downloaded %d times, want 2", provider.callCounts[snapshot.Files[0].BackupPath])
	}
}

func TestRestoreFromSnapshot_NoFiles(t *testing.T) {
	provider, snapID := setupRestoreTestSnapshot(t, map[string]string{
		"file.txt": "data",
	})

	cfg := RestoreConfig{
		SnapshotID:    snapID,
		TargetPath:    t.TempDir(),
		SelectedPaths: []string{"/nonexistent/path"},
	}

	result, err := RestoreFromSnapshot(provider, cfg, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "completed" {
		t.Errorf("expected completed (empty), got %s", result.Status)
	}
	if result.FilesRestored != 0 {
		t.Errorf("expected 0 files, got %d", result.FilesRestored)
	}
	if len(result.Warnings) == 0 {
		t.Error("expected warning about no matching files")
	}
}

func TestRestoreFromSnapshot_NilProvider(t *testing.T) {
	_, err := RestoreFromSnapshot(nil, RestoreConfig{SnapshotID: "x"}, nil)
	if err == nil {
		t.Error("expected error for nil provider")
	}
}

func TestRestoreFromSnapshot_EmptySnapshotID(t *testing.T) {
	provider := providers.NewLocalProvider(t.TempDir())
	_, err := RestoreFromSnapshot(provider, RestoreConfig{}, nil)
	if err == nil {
		t.Error("expected error for empty snapshot ID")
	}
}

func TestResumeState_SaveLoad(t *testing.T) {
	dir := t.TempDir()

	state := &ResumeState{
		SnapshotID: "snap-123",
		CompletedFiles: map[string]bool{
			"snapshots/snap-123/files/a.txt.gz": true,
			"snapshots/snap-123/files/b.txt.gz": true,
		},
		BytesRestored: 12345,
	}

	if err := SaveResumeState(dir, state); err != nil {
		t.Fatalf("save: %v", err)
	}

	loaded, err := LoadResumeState(dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded == nil {
		t.Fatal("loaded state is nil")
	}
	if loaded.SnapshotID != state.SnapshotID {
		t.Errorf("snapshotID: got %s, want %s", loaded.SnapshotID, state.SnapshotID)
	}
	if loaded.BytesRestored != state.BytesRestored {
		t.Errorf("bytesRestored: got %d, want %d", loaded.BytesRestored, state.BytesRestored)
	}
	if len(loaded.CompletedFiles) != 2 {
		t.Errorf("completedFiles count: got %d, want 2", len(loaded.CompletedFiles))
	}
	for k := range state.CompletedFiles {
		if !loaded.CompletedFiles[k] {
			t.Errorf("completedFiles missing key: %s", k)
		}
	}
}

func TestResumeState_LoadNonExistent(t *testing.T) {
	dir := t.TempDir()

	state, err := LoadResumeState(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if state != nil {
		t.Error("expected nil state for nonexistent file")
	}
}

func TestCleanupResumeState(t *testing.T) {
	dir := t.TempDir()

	// Save then cleanup
	state := &ResumeState{
		SnapshotID:     "snap-x",
		CompletedFiles: map[string]bool{},
	}
	if err := SaveResumeState(dir, state); err != nil {
		t.Fatalf("save: %v", err)
	}

	if err := CleanupResumeState(dir); err != nil {
		t.Fatalf("cleanup: %v", err)
	}

	// Verify file is gone
	loaded, err := LoadResumeState(dir)
	if err != nil {
		t.Fatalf("load after cleanup: %v", err)
	}
	if loaded != nil {
		t.Error("expected nil state after cleanup")
	}
}

func TestCleanupResumeState_Idempotent(t *testing.T) {
	dir := t.TempDir()
	// Cleaning up when no file exists should not error
	if err := CleanupResumeState(dir); err != nil {
		t.Fatalf("cleanup nonexistent: %v", err)
	}
}

func TestFilterFiles(t *testing.T) {
	files := []SnapshotFile{
		{SourcePath: "/data/reports/q1.csv"},
		{SourcePath: "/data/reports/q2.csv"},
		{SourcePath: "/data/config/app.yaml"},
		{SourcePath: "/logs/app.log"},
	}

	tests := []struct {
		name     string
		prefixes []string
		want     int
	}{
		{"no filter", nil, 4},
		{"empty filter", []string{}, 4},
		{"single prefix", []string{"/data/reports"}, 2},
		{"multiple prefixes", []string{"/data/config", "/logs"}, 2},
		{"no match", []string{"/nonexistent"}, 0},
		{"all match", []string{"/data", "/logs"}, 4},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := filterFiles(files, tt.prefixes)
			if len(got) != tt.want {
				t.Errorf("filterFiles(%v) returned %d files, want %d", tt.prefixes, len(got), tt.want)
			}
		})
	}
}
