package backup

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
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

// TestRestoreFromSnapshot_LongSourcePath proves D4: a manifest entry whose
// SourcePath is long enough that the object's BackupPath (snapshot prefix +
// "files/" + the full original source path) exceeds the filesystem's
// per-component name limit (~255 bytes on ext4/APFS/NTFS) once flattened
// into a single staging filename must still restore successfully. The
// object itself uploads fine (the source path keeps its real directory
// structure — no single filesystem component here is longer than 150
// bytes), matching the proven live scenario where the object existed in
// storage and integrity/test-restore both passed it, but the real restore's
// OLD staging filename (built by replacing every "/" in the BackupPath with
// "_", collapsing it into one oversized path component) failed to open with
// "file name too long" and the file was silently dropped into failedFiles.
func TestRestoreFromSnapshot_LongSourcePath(t *testing.T) {
	longDir := strings.Repeat("d", 150)
	longFile := strings.Repeat("f", 150) + ".txt"
	name := longDir + "/" + longFile

	provider, snapID := setupRestoreTestSnapshot(t, map[string]string{
		name: "long path content",
	})

	snapshot, err := downloadManifest(provider, snapID)
	if err != nil {
		t.Fatalf("download manifest: %v", err)
	}
	if len(snapshot.Files) != 1 {
		t.Fatalf("expected 1 file in manifest, got %d", len(snapshot.Files))
	}
	sourcePath := snapshot.Files[0].SourcePath
	if len(sourcePath) < 300 {
		t.Fatalf("test setup: SourcePath %q is only %d chars, want 300+", sourcePath, len(sourcePath))
	}

	targetDir := t.TempDir()
	cfg := RestoreConfig{
		SnapshotID: snapID,
		TargetPath: targetDir,
	}

	result, err := RestoreFromSnapshot(provider, cfg, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "completed" {
		t.Fatalf("status = %q (failedFiles=%v, warnings=%v), want completed — a long source path must not be silently dropped",
			result.Status, result.FailedFiles, result.Warnings)
	}
	if result.FilesRestored != 1 {
		t.Fatalf("FilesRestored = %d, want 1", result.FilesRestored)
	}

	wantTarget := resolveTargetPath(targetDir, sourcePath)
	data, err := os.ReadFile(wantTarget)
	if err != nil {
		t.Fatalf("restored file not found at expected target %q: %v", wantTarget, err)
	}
	if string(data) != "long path content" {
		t.Errorf("restored content = %q, want %q", data, "long path content")
	}
}

// TestStagingFileName_BoundedAndInjective proves the local staging filename
// derived from a BackupPath (a) never exceeds a small, filesystem-safe
// length regardless of how long the source path was, and (b) stays
// injective — two distinct BackupPaths must never derive the same staging
// filename, which would let one download's bytes land on top of another's
// in the staging directory.
func TestStagingFileName_BoundedAndInjective(t *testing.T) {
	longBackupPath := "snapshots/" + strings.Repeat("s", 40) + "/files/" +
		strings.Repeat("d", 150) + "/" + strings.Repeat("f", 150) + ".txt.gz"

	got := stagingFileName(longBackupPath)
	if len(got) > 80 {
		t.Errorf("staging file name length = %d, want <= 80 (name: %q)", len(got), got)
	}

	other := stagingFileName(longBackupPath + "-different")
	if got == other {
		t.Errorf("distinct BackupPaths %q and %q produced the same staging file name %q", longBackupPath, longBackupPath+"-different", got)
	}

	// Stable/deterministic: the same BackupPath must always derive the same
	// staging filename (resume and retry logic download to this path across
	// multiple attempts within the same run).
	if again := stagingFileName(longBackupPath); again != got {
		t.Errorf("stagingFileName(%q) not deterministic: got %q then %q", longBackupPath, got, again)
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
		SnapshotID: snapID,
		TargetPath: targetDir,
		// Exact file selections (not "/original/config" as a bare partial-name
		// prefix — that string also prefix-matches "config.txt" under the old,
		// pre-D5-fix strings.HasPrefix semantics, which is precisely the bug:
		// a partial name is not a valid selection of a whole file or directory).
		SelectedPaths: []string{"/original/config.txt", "/original/data.csv"},
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

// TestFilterFiles_SiblingCollisionAndSeparators proves D5: filterFiles must
// match a selection against a manifest entry's SourcePath by exact equality
// or a directory boundary (selected + separator) — never by a bare string
// prefix. A plain strings.HasPrefix (the old behavior) also matched
// unrelated siblings that merely share a leading substring, so selecting
// one file silently pulled in — and, on an in-place restore, silently
// overwrote — files the operator never chose.
func TestFilterFiles_SiblingCollisionAndSeparators(t *testing.T) {
	t.Run("selecting a single file does not match siblings sharing its name as a prefix", func(t *testing.T) {
		files := []SnapshotFile{
			{SourcePath: "/x/prefix/pick.txt"},
			{SourcePath: "/x/prefix/pick.txt.bak"},
			{SourcePath: "/x/prefix/pick.txt2"},
			{SourcePath: "/x/prefix/pick.txtx/inner.txt"},
		}

		got := filterFiles(files, []string{"/x/prefix/pick.txt"})
		if len(got) != 1 || got[0].SourcePath != "/x/prefix/pick.txt" {
			gotPaths := make([]string, len(got))
			for i, f := range got {
				gotPaths[i] = f.SourcePath
			}
			t.Errorf("filterFiles selecting a single file = %v, want only [/x/prefix/pick.txt]", gotPaths)
		}
	})

	t.Run("selecting the parent directory matches everything under it, siblings included", func(t *testing.T) {
		files := []SnapshotFile{
			{SourcePath: "/x/prefix/pick.txt"},
			{SourcePath: "/x/prefix/pick.txt.bak"},
			{SourcePath: "/x/prefix/pick.txt2"},
			{SourcePath: "/x/prefix/pick.txtx/inner.txt"},
		}

		got := filterFiles(files, []string{"/x/prefix"})
		if len(got) != 4 {
			t.Errorf("filterFiles selecting the parent directory returned %d files, want 4 (all of them)", len(got))
		}
	})

	t.Run("Windows-style backslash paths: single file selection excludes siblings", func(t *testing.T) {
		files := []SnapshotFile{
			{SourcePath: `C:\x\prefix\pick.txt`},
			{SourcePath: `C:\x\prefix\pick.txt.bak`},
		}

		got := filterFiles(files, []string{`C:\x\prefix\pick.txt`})
		if len(got) != 1 || got[0].SourcePath != `C:\x\prefix\pick.txt` {
			gotPaths := make([]string, len(got))
			for i, f := range got {
				gotPaths[i] = f.SourcePath
			}
			t.Errorf("filterFiles (Windows-style) selecting a single file = %v, want only [C:\\x\\prefix\\pick.txt]", gotPaths)
		}
	})

	t.Run("Windows-style backslash paths: directory selection includes siblings", func(t *testing.T) {
		files := []SnapshotFile{
			{SourcePath: `C:\x\prefix\pick.txt`},
			{SourcePath: `C:\x\prefix\pick.txt.bak`},
		}

		got := filterFiles(files, []string{`C:\x\prefix`})
		if len(got) != 2 {
			t.Errorf("filterFiles (Windows-style) selecting the parent directory returned %d files, want 2 (both)", len(got))
		}
	})
}

// The shadow SourcePath/OriginalPath pair below is the exact live D8
// proof: manifest entries under VSS carry a per-run shadow-copy device
// path as SourcePath and the real, human-visible location as OriginalPath.
const (
	d8ShadowSourcePath = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\assure\src\x`
	d8OriginalPath     = `C:\assure\src\x`
)

// TestRestoreSourcePath_PrefersOriginalPathUnderVSS proves restoreSourcePath
// itself: OriginalPath wins whenever set, never the VSS shadow-device
// SourcePath.
func TestRestoreSourcePath_PrefersOriginalPathUnderVSS(t *testing.T) {
	f := SnapshotFile{SourcePath: d8ShadowSourcePath, OriginalPath: d8OriginalPath}
	if got := restoreSourcePath(f); got != d8OriginalPath {
		t.Fatalf("restoreSourcePath = %q, want the original path %q, not the shadow device path", got, d8OriginalPath)
	}

	// The common, non-VSS case: OriginalPath unset falls back to SourcePath.
	plain := SnapshotFile{SourcePath: "/data/plain.txt"}
	if got := restoreSourcePath(plain); got != "/data/plain.txt" {
		t.Fatalf("restoreSourcePath (no OriginalPath) = %q, want SourcePath %q", got, "/data/plain.txt")
	}
}

// TestResolveTargetPath_UsesOriginalPathUnderVSS is D8's core proof for
// destination computation: a manifest entry whose SourcePath is the VSS
// shadow-copy device path must resolve its restore destination from
// OriginalPath, landing under "assure/src/x" relative to the target base —
// never under the shadow-device form, which is either gone by restore time
// or (worse) present under a DIFFERENT shadow ID from a later run, silently
// splitting one logical file tree across ShadowCopy1/ShadowCopy2/...
// (proven live). Exercised against both a Unix-style and a Windows-style
// target base — the Windows one via withWindowsVolumeName so it also runs
// on Linux/macOS CI, matching TestResolveTargetPathStripsEmbeddedDrive's
// pattern of computing the expectation with filepath.Join for
// GOOS-independence.
func TestResolveTargetPath_UsesOriginalPathUnderVSS(t *testing.T) {
	withWindowsVolumeName(t)

	f := SnapshotFile{SourcePath: d8ShadowSourcePath, OriginalPath: d8OriginalPath}
	resolved := restoreSourcePath(f)

	t.Run("unix-style target base", func(t *testing.T) {
		const targetBase = "/alt"
		got := resolveTargetPath(targetBase, resolved)
		want := filepath.Join(targetBase, `assure\src\x`)
		if got != want {
			t.Fatalf("resolveTargetPath(%q, ...) = %q, want %q", targetBase, got, want)
		}
		if strings.Contains(got, "GLOBALROOT") {
			t.Fatalf("computed target path leaked the VSS shadow-device form: %q", got)
		}
	})

	t.Run("windows-style target base", func(t *testing.T) {
		const targetBase = `C:\alt`
		got := resolveTargetPath(targetBase, resolved)
		want := filepath.Join(targetBase, `assure\src\x`)
		if got != want {
			t.Fatalf("resolveTargetPath(%q, ...) = %q, want %q", targetBase, got, want)
		}
		if strings.Contains(got, "GLOBALROOT") {
			t.Fatalf("computed target path leaked the VSS shadow-device form: %q", got)
		}
	})
}

// TestFilterFiles_MatchesOriginalPathUnderVSS proves selective restore's
// selection matching goes through OriginalPath, not the raw SourcePath: the
// API validates/indexes selectedPaths against each file's original,
// human-visible location, so a selection of "C:\assure\src\x" must match a
// manifest entry whose SourcePath is the shadow-device form.
func TestFilterFiles_MatchesOriginalPathUnderVSS(t *testing.T) {
	files := []SnapshotFile{
		{SourcePath: d8ShadowSourcePath, OriginalPath: d8OriginalPath},
		{SourcePath: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\assure\other\y`, OriginalPath: `C:\assure\other\y`},
	}

	got := filterFiles(files, []string{d8OriginalPath})
	if len(got) != 1 || got[0].OriginalPath != d8OriginalPath {
		t.Fatalf("filterFiles selecting the original path = %+v, want exactly the entry whose OriginalPath is %q", got, d8OriginalPath)
	}

	// Selecting the raw shadow-device SourcePath must NOT be required to
	// match (it's an internal, per-run-ephemeral value the API never
	// indexes selections against) — but proving the ORIGINAL-path match
	// works is the load-bearing assertion above; this just documents that a
	// selection by the (correct, real) original path is what a caller uses.
}

// TestRestoreFromSnapshot_LandsUnderOriginalPathUnderVSS is the full
// end-to-end proof (D8): RestoreFromSnapshotContext, given a manifest entry
// whose SourcePath is a per-run shadow-copy-style path and whose
// OriginalPath is the real location, must actually write the restored file
// on disk under the ORIGINAL path's relative structure beneath TargetPath —
// not under the shadow path's. Uses forward-slash paths (rather than the
// literal Windows shadow-device string) so the written file's real,
// on-disk location can be asserted portably in CI.
func TestRestoreFromSnapshot_LandsUnderOriginalPathUnderVSS(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)

	snapshotID := "vss-shadow-snap"
	prefix := filepath.Join("snapshots", snapshotID)

	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "x")
	content := []byte("vss-shadow-content")
	if err := os.WriteFile(srcPath, content, 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}

	backupPath := filepath.Join(prefix, "files", "x.gz")
	if err := provider.Upload(srcPath, backupPath); err != nil {
		t.Fatalf("upload: %v", err)
	}

	// SourcePath mimics a per-run VSS shadow-copy device path (using
	// forward slashes so filepath.Join produces real nested directories on
	// every CI platform); OriginalPath is the real, stable location.
	const shadowSourcePath = "/vss-shadow-copy-1/assure/src/x"
	const originalPath = "/assure/src/x"
	snapshot := Snapshot{
		ID: snapshotID,
		Files: []SnapshotFile{
			{SourcePath: shadowSourcePath, OriginalPath: originalPath, BackupPath: filepath.ToSlash(backupPath), Size: int64(len(content))},
		},
		Size: int64(len(content)),
	}
	manifestData, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	manifestTmp := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(manifestTmp, manifestData, 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if err := provider.Upload(manifestTmp, filepath.Join(prefix, "manifest.json")); err != nil {
		t.Fatalf("upload manifest: %v", err)
	}

	targetDir := t.TempDir()
	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: targetDir}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "completed" {
		t.Fatalf("expected status completed, got %s (error: %s)", result.Status, result.Error)
	}
	if result.FilesRestored != 1 {
		t.Fatalf("expected 1 file restored, got %d", result.FilesRestored)
	}

	wantPath := filepath.Join(targetDir, "assure", "src", "x")
	restored, err := os.ReadFile(wantPath)
	if err != nil {
		t.Fatalf("expected the file to land at %q (the ORIGINAL path, not the shadow path): %v", wantPath, err)
	}
	if string(restored) != string(content) {
		t.Fatalf("restored content = %q, want %q", restored, content)
	}

	// Regression guard: the shadow-copy path segment must never appear
	// anywhere on disk under targetDir.
	shadowPath := filepath.Join(targetDir, "vss-shadow-copy-1")
	if _, statErr := os.Stat(shadowPath); statErr == nil {
		t.Fatalf("file was restored under the shadow-copy path %q instead of the original path", shadowPath)
	}
}

// alwaysFailDownloadProvider wraps a LocalProvider and fails every Download
// call whose remotePath is in the fail set, so a test can force a
// deterministic per-file download failure.
type alwaysFailDownloadProvider struct {
	*providers.LocalProvider
	fail map[string]bool
}

func (p *alwaysFailDownloadProvider) Download(remotePath, localPath string) error {
	if p.fail[remotePath] {
		return errors.New("injected download failure")
	}
	return p.LocalProvider.Download(remotePath, localPath)
}

// TestRestoreFromSnapshot_FailedFilesUseOriginalPathUnderVSS proves the
// silent-failure fix from the PR #5418 review: filterFiles/pathSelection/
// targetPath were switched to restoreSourcePath(file), but result.FailedFiles
// (and Warnings/progress) still reported the raw, per-run-ephemeral VSS
// shadow-device SourcePath on failure — meaningless (and possibly already
// gone) by the time an operator reads the result. A file whose SourcePath is
// the shadow path and whose OriginalPath is the real location, that fails to
// download, must report FailedFiles[0] as the real OriginalPath.
func TestRestoreFromSnapshot_FailedFilesUseOriginalPathUnderVSS(t *testing.T) {
	baseDir := t.TempDir()
	base := providers.NewLocalProvider(baseDir)

	snapshotID := "vss-shadow-fail-snap"
	prefix := filepath.Join("snapshots", snapshotID)

	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "x")
	content := []byte("vss-shadow-fail-content")
	if err := os.WriteFile(srcPath, content, 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}

	backupPath := filepath.Join(prefix, "files", "x.gz")
	if err := base.Upload(srcPath, backupPath); err != nil {
		t.Fatalf("upload: %v", err)
	}

	const shadowSourcePath = "/vss-shadow-copy-1/assure/src/x"
	const originalPath = "/assure/src/x"
	snapshot := Snapshot{
		ID: snapshotID,
		Files: []SnapshotFile{
			{SourcePath: shadowSourcePath, OriginalPath: originalPath, BackupPath: filepath.ToSlash(backupPath), Size: int64(len(content))},
		},
		Size: int64(len(content)),
	}
	manifestData, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	manifestTmp := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(manifestTmp, manifestData, 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if err := base.Upload(manifestTmp, filepath.Join(prefix, "manifest.json")); err != nil {
		t.Fatalf("upload manifest: %v", err)
	}

	provider := &alwaysFailDownloadProvider{
		LocalProvider: base,
		fail:          map[string]bool{filepath.ToSlash(backupPath): true},
	}

	targetDir := t.TempDir()
	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: targetDir}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.FilesFailed != 1 || len(result.FailedFiles) != 1 {
		t.Fatalf("expected exactly 1 failed file, got FilesFailed=%d FailedFiles=%v", result.FilesFailed, result.FailedFiles)
	}
	if result.FailedFiles[0] != originalPath {
		t.Fatalf("FailedFiles[0] = %q, want the real path %q (not the VSS shadow path %q)", result.FailedFiles[0], originalPath, shadowSourcePath)
	}
}
