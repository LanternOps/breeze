package backup

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	pathpkg "path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// mockProvider implements providers.BackupProvider for testing.
type mockProvider struct {
	mu          sync.Mutex
	uploads     map[string]string // remotePath -> localPath (content copied)
	files       map[string][]byte // stored content by remotePath
	listResult  map[string][]string
	uploadErr   error
	downloadErr error
	listErr     error
	deleteErr   error

	uploadCalls   []uploadCall
	deleteCalls   []string
	downloadCalls []downloadCall
}

type uploadCall struct {
	localPath  string
	remotePath string
}

type downloadCall struct {
	remotePath string
	localPath  string
}

func newMockProvider() *mockProvider {
	return &mockProvider{
		uploads:    make(map[string]string),
		files:      make(map[string][]byte),
		listResult: make(map[string][]string),
	}
}

func (m *mockProvider) Upload(localPath, remotePath string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.uploadCalls = append(m.uploadCalls, uploadCall{localPath, remotePath})
	if m.uploadErr != nil {
		return m.uploadErr
	}
	data, err := os.ReadFile(localPath)
	if err != nil {
		return fmt.Errorf("mock upload read error: %w", err)
	}
	m.files[remotePath] = data
	m.uploads[remotePath] = localPath
	return nil
}

func (m *mockProvider) Download(remotePath, localPath string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.downloadCalls = append(m.downloadCalls, downloadCall{remotePath, localPath})
	if m.downloadErr != nil {
		return m.downloadErr
	}
	data, ok := m.files[remotePath]
	if !ok {
		return fmt.Errorf("mock download: file not found: %s", remotePath)
	}
	return os.WriteFile(localPath, data, 0644)
}

func (m *mockProvider) List(prefix string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.listErr != nil {
		return nil, m.listErr
	}
	// Return matching files from stored files
	if result, ok := m.listResult[prefix]; ok {
		return result, nil
	}
	var results []string
	for key := range m.files {
		if strings.HasPrefix(key, prefix) {
			results = append(results, key)
		}
	}
	return results, nil
}

func (m *mockProvider) Delete(remotePath string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.deleteCalls = append(m.deleteCalls, remotePath)
	if m.deleteErr != nil {
		return m.deleteErr
	}
	delete(m.files, remotePath)
	delete(m.uploads, remotePath)
	return nil
}

func TestCreateSnapshot_Success(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "file1.txt", "content one")
	file2 := createTempFile(t, tmpDir, "file2.txt", "content two")

	provider := newMockProvider()
	files := []backupFile{
		{sourcePath: file1, snapshotPath: "path_0/file1.txt", size: 11, modTime: time.Now()},
		{sourcePath: file2, snapshotPath: "path_0/file2.txt", size: 11, modTime: time.Now()},
	}

	snapshot, err := CreateSnapshot(provider, files)
	if err != nil {
		t.Fatalf("CreateSnapshot failed: %v", err)
	}
	if snapshot == nil {
		t.Fatal("snapshot is nil")
	}
	if snapshot.ID == "" {
		t.Error("snapshot ID should not be empty")
	}
	if !strings.HasPrefix(snapshot.ID, "snapshot-") {
		t.Errorf("snapshot ID should start with 'snapshot-', got %q", snapshot.ID)
	}
	if len(snapshot.Files) != 2 {
		t.Fatalf("expected 2 files, got %d", len(snapshot.Files))
	}
	if snapshot.Size != 22 {
		t.Errorf("expected total size 22, got %d", snapshot.Size)
	}
	if snapshot.Timestamp.IsZero() {
		t.Error("snapshot timestamp should not be zero")
	}

	// Verify files were uploaded (2 data files + 1 manifest)
	if len(provider.uploadCalls) != 3 {
		t.Errorf("expected 3 upload calls (2 files + manifest), got %d", len(provider.uploadCalls))
	}

	// Verify manifest was uploaded
	manifestUploaded := false
	for key := range provider.files {
		if strings.HasSuffix(key, "manifest.json") {
			manifestUploaded = true
			break
		}
	}
	if !manifestUploaded {
		t.Error("manifest should be uploaded")
	}
}

func TestCreateSnapshot_NilProvider(t *testing.T) {
	files := []backupFile{
		{sourcePath: "/tmp/x", snapshotPath: "path_0/x", size: 1},
	}
	_, err := CreateSnapshot(nil, files)
	if err == nil {
		t.Fatal("expected error for nil provider")
	}
	if !strings.Contains(err.Error(), "backup provider is required") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCreateSnapshot_NoFiles(t *testing.T) {
	provider := newMockProvider()
	_, err := CreateSnapshot(provider, nil)
	if err == nil {
		t.Fatal("expected error for no files")
	}
	if !strings.Contains(err.Error(), "no files provided") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCreateSnapshot_EmptyFileSlice(t *testing.T) {
	provider := newMockProvider()
	_, err := CreateSnapshot(provider, []backupFile{})
	if err == nil {
		t.Fatal("expected error for empty files slice")
	}
}

func TestDeleteSnapshot_DoesNotDeleteAdjacentPrefix(t *testing.T) {
	provider := newMockProvider()
	oldSnapshot := Snapshot{
		ID:        "snapshot-abc",
		Timestamp: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	}
	adjacentSnapshot := Snapshot{
		ID:        "snapshot-abc2",
		Timestamp: time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC),
	}
	newSnapshot := Snapshot{
		ID:        "snapshot-def",
		Timestamp: time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC),
	}

	for _, snapshot := range []Snapshot{oldSnapshot, adjacentSnapshot, newSnapshot} {
		manifest, err := json.Marshal(snapshot)
		if err != nil {
			t.Fatalf("marshal snapshot: %v", err)
		}
		provider.files[path.Join(snapshotRootDir, snapshot.ID, snapshotManifestKey)] = manifest
		provider.files[path.Join(snapshotRootDir, snapshot.ID, snapshotFilesDir, "data.txt.gz")] = []byte(snapshot.ID)
	}

	if err := DeleteSnapshot(provider, 2); err != nil {
		t.Fatalf("DeleteSnapshot failed: %v", err)
	}

	deleted := map[string]bool{}
	for _, key := range provider.deleteCalls {
		deleted[key] = true
		if strings.Contains(key, "snapshot-abc2/") {
			t.Fatalf("deleted adjacent-prefix key %q", key)
		}
	}

	for _, key := range []string{
		path.Join(snapshotRootDir, oldSnapshot.ID, snapshotManifestKey),
		path.Join(snapshotRootDir, oldSnapshot.ID, snapshotFilesDir, "data.txt.gz"),
	} {
		if !deleted[key] {
			t.Fatalf("expected old snapshot key %q to be deleted; calls=%v", key, provider.deleteCalls)
		}
	}

	for _, key := range []string{
		path.Join(snapshotRootDir, adjacentSnapshot.ID, snapshotManifestKey),
		path.Join(snapshotRootDir, adjacentSnapshot.ID, snapshotFilesDir, "data.txt.gz"),
		path.Join(snapshotRootDir, newSnapshot.ID, snapshotManifestKey),
		path.Join(snapshotRootDir, newSnapshot.ID, snapshotFilesDir, "data.txt.gz"),
	} {
		if _, ok := provider.files[key]; !ok {
			t.Fatalf("expected retained key %q to remain", key)
		}
	}
}

func TestCreateSnapshot_PartialUploadFailure(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "good.txt", "good content")

	provider := newMockProvider()
	// Override Upload to fail on second file
	failProvider := &failingUploadProvider{
		backingProvider: provider,
		failOn:          1, // fail on 2nd call (0-indexed)
	}

	files := []backupFile{
		{sourcePath: file1, snapshotPath: "path_0/good.txt", size: 12, modTime: time.Now()},
		{sourcePath: "/nonexistent/bad.txt", snapshotPath: "path_0/bad.txt", size: 5, modTime: time.Now()},
	}

	snapshot, err := CreateSnapshot(failProvider, files)
	// Should succeed partially - one file uploaded, one failed
	if snapshot == nil {
		t.Fatal("snapshot should not be nil for partial success")
	}
	if len(snapshot.Files) != 1 {
		t.Fatalf("expected 1 successfully uploaded file, got %d", len(snapshot.Files))
	}
	if err != nil {
		t.Logf("partial error (expected): %v", err)
	}
}

func TestCreateSnapshot_AllUploadsFail(t *testing.T) {
	provider := newMockProvider()
	provider.uploadErr = errors.New("storage unavailable")

	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "file1.txt", "data")

	files := []backupFile{
		{sourcePath: file1, snapshotPath: "path_0/file1.txt", size: 4, modTime: time.Now()},
	}

	snapshot, err := CreateSnapshot(provider, files)
	if err == nil {
		t.Fatal("expected error when all uploads fail")
	}
	if snapshot != nil {
		t.Error("snapshot should be nil when all uploads fail")
	}
}

func TestCreateSnapshot_GzipExtensionAdded(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "data.txt", "content")

	provider := newMockProvider()
	files := []backupFile{
		{sourcePath: file1, snapshotPath: "path_0/data.txt", size: 7, modTime: time.Now()},
	}

	snapshot, err := CreateSnapshot(provider, files)
	if err != nil {
		t.Fatalf("CreateSnapshot failed: %v", err)
	}

	if len(snapshot.Files) != 1 {
		t.Fatalf("expected 1 file, got %d", len(snapshot.Files))
	}

	backupPath := snapshot.Files[0].BackupPath
	if !strings.HasSuffix(backupPath, ".gz") {
		t.Errorf("backup path should end with .gz, got %q", backupPath)
	}
}

func TestCreateSnapshot_AlreadyGzExtension(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "data.txt.gz", "compressed")

	provider := newMockProvider()
	files := []backupFile{
		{sourcePath: file1, snapshotPath: "path_0/data.txt.gz", size: 10, modTime: time.Now()},
	}

	snapshot, err := CreateSnapshot(provider, files)
	if err != nil {
		t.Fatalf("CreateSnapshot failed: %v", err)
	}

	backupPath := snapshot.Files[0].BackupPath
	if strings.HasSuffix(backupPath, ".gz.gz") {
		t.Errorf("should not double .gz extension, got %q", backupPath)
	}
}

func TestCreateSnapshot_PreservesFileMetadata(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "meta.txt", "metadata test")

	modTime := time.Date(2026, 2, 15, 10, 30, 0, 0, time.UTC)
	provider := newMockProvider()
	files := []backupFile{
		{sourcePath: file1, snapshotPath: "path_0/meta.txt", size: 13, modTime: modTime},
	}

	snapshot, err := CreateSnapshot(provider, files)
	if err != nil {
		t.Fatalf("CreateSnapshot failed: %v", err)
	}

	if snapshot.Files[0].SourcePath != file1 {
		t.Errorf("SourcePath = %q, want %q", snapshot.Files[0].SourcePath, file1)
	}
	if snapshot.Files[0].Size != 13 {
		t.Errorf("Size = %d, want 13", snapshot.Files[0].Size)
	}
	if !snapshot.Files[0].ModTime.Equal(modTime) {
		t.Errorf("ModTime = %v, want %v", snapshot.Files[0].ModTime, modTime)
	}
}

func TestEnsureGzipExtension(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"file.txt", "file.txt.gz"},
		{"file.txt.gz", "file.txt.gz"},
		{"path/to/data", "path/to/data.gz"},
		{"path/to/data.gz", "path/to/data.gz"},
		{"", ".gz"},
		{".gz", ".gz"},
		{"file.GZ", "file.GZ.gz"}, // case-sensitive
	}

	for _, tt := range tests {
		got := ensureGzipExtension(tt.input)
		if got != tt.want {
			t.Errorf("ensureGzipExtension(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestIsManifestPath(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"snapshots/snap-1/manifest.json", true},
		{"snapshots/snap-1/files/data.gz", false},
		{"manifest.json", true},
		{"other/manifest.json", true},
		{"snapshots/snap-1/files/manifest.json.gz", false},
		{"", false},
		{"not-a-manifest.json", false},
	}

	for _, tt := range tests {
		got := isManifestPath(tt.input)
		if got != tt.want {
			t.Errorf("isManifestPath(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestWriteSnapshotManifest(t *testing.T) {
	snapshot := &Snapshot{
		ID:        "test-snapshot",
		Timestamp: time.Date(2026, 3, 13, 12, 0, 0, 0, time.UTC),
		Files: []SnapshotFile{
			{SourcePath: "/data/file.txt", BackupPath: "snapshots/test/files/file.txt.gz", Size: 100, ModTime: time.Date(2026, 3, 13, 11, 0, 0, 0, time.UTC)},
		},
		Size: 100,
	}

	manifestPath, err := writeSnapshotManifest(snapshot)
	if err != nil {
		t.Fatalf("writeSnapshotManifest failed: %v", err)
	}
	defer os.Remove(manifestPath)

	data, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("failed to read manifest: %v", err)
	}

	var decoded Snapshot
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to decode manifest JSON: %v", err)
	}

	if decoded.ID != "test-snapshot" {
		t.Errorf("ID = %q, want %q", decoded.ID, "test-snapshot")
	}
	if len(decoded.Files) != 1 {
		t.Fatalf("expected 1 file in manifest, got %d", len(decoded.Files))
	}
	if decoded.Files[0].SourcePath != "/data/file.txt" {
		t.Errorf("SourcePath = %q, want %q", decoded.Files[0].SourcePath, "/data/file.txt")
	}
	if decoded.Size != 100 {
		t.Errorf("Size = %d, want 100", decoded.Size)
	}
}

func TestNewSnapshotID_Format(t *testing.T) {
	id := newSnapshotID()
	if !strings.HasPrefix(id, "snapshot-") {
		t.Errorf("snapshot ID should start with 'snapshot-', got %q", id)
	}
	// Should contain a timestamp-like section
	if !strings.Contains(id, "T") || !strings.Contains(id, "Z") {
		t.Errorf("snapshot ID should contain ISO-like timestamp, got %q", id)
	}
}

func TestNewJobID_Format(t *testing.T) {
	id := newJobID()
	if !strings.HasPrefix(id, "job-") {
		t.Errorf("job ID should start with 'job-', got %q", id)
	}
}

func TestNewID_Uniqueness(t *testing.T) {
	seen := make(map[string]struct{})
	for i := 0; i < 100; i++ {
		id := newID("test")
		if _, exists := seen[id]; exists {
			t.Fatalf("duplicate ID generated: %s", id)
		}
		seen[id] = struct{}{}
	}
}

// --- helpers ---

func createTempFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := pathpkg.Join(dir, name)
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		t.Fatalf("failed to create temp file %s: %v", name, err)
	}
	return p
}

func storeManifest(t *testing.T, provider *mockProvider, snap *Snapshot) {
	t.Helper()
	data, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("failed to marshal snapshot: %v", err)
	}
	manifestKey := path.Join(snapshotRootDir, snap.ID, snapshotManifestKey)
	provider.files[manifestKey] = data
}

// failingUploadProvider wraps a provider and fails on a specific upload call.
type failingUploadProvider struct {
	backingProvider interface {
		Upload(string, string) error
		Download(string, string) error
		List(string) ([]string, error)
		Delete(string) error
	}
	failOn    int
	callCount int
	mu        sync.Mutex
}

func (f *failingUploadProvider) Upload(localPath, remotePath string) error {
	f.mu.Lock()
	count := f.callCount
	f.callCount++
	f.mu.Unlock()

	if count == f.failOn {
		return fmt.Errorf("simulated upload failure for %s", remotePath)
	}
	return f.backingProvider.Upload(localPath, remotePath)
}

func (f *failingUploadProvider) Download(remotePath, localPath string) error {
	return f.backingProvider.Download(remotePath, localPath)
}

func (f *failingUploadProvider) List(prefix string) ([]string, error) {
	return f.backingProvider.List(prefix)
}

func (f *failingUploadProvider) Delete(remotePath string) error {
	return f.backingProvider.Delete(remotePath)
}
