package backup

import (
	"context"
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

	"github.com/breeze-rmm/agent/internal/backup/providers"
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
	restore := setUploadRetryDelayForTest(0) // the failing file now gets one retry; don't wait out the real backoff
	defer restore()

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

// stallOnceProvider blocks every UploadContext call for the first distinct
// localPath it sees (returning ctx.Err() once the passed context is done),
// and succeeds immediately for every other file. Keying on localPath (rather
// than call count) means the stalled file stays stalled across the per-file
// upload retry too, so it models a single permanently-dead connection to one
// file in an otherwise-healthy upload run.
type stallOnceProvider struct {
	mu        sync.Mutex
	stallPath string
}

func (p *stallOnceProvider) Upload(localPath, remotePath string) error {
	return p.UploadContext(context.Background(), localPath, remotePath)
}

func (p *stallOnceProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	p.mu.Lock()
	if p.stallPath == "" {
		p.stallPath = localPath
	}
	stall := localPath == p.stallPath
	p.mu.Unlock()

	if stall {
		<-ctx.Done()
		return ctx.Err()
	}
	return nil
}

func (p *stallOnceProvider) Download(remotePath, localPath string) error { return nil }
func (p *stallOnceProvider) List(prefix string) ([]string, error)        { return nil, nil }
func (p *stallOnceProvider) Delete(remotePath string) error              { return nil }

// okProvider is a minimal contextUploader whose UploadContext always
// succeeds immediately, for tests that only care about progress callback
// behavior and don't need upload content/call tracking.
type okProvider struct{}

func (p *okProvider) Upload(localPath, remotePath string) error { return nil }
func (p *okProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	return nil
}
func (p *okProvider) Download(remotePath, localPath string) error { return nil }
func (p *okProvider) List(prefix string) ([]string, error)        { return nil, nil }
func (p *okProvider) Delete(remotePath string) error              { return nil }

func TestSnapshotProgressCallback(t *testing.T) {
	p := &okProvider{} // UploadContext always succeeds
	files := []backupFile{
		{sourcePath: writeTempFile(t, "a"), snapshotPath: "a", size: 10},
		{sourcePath: writeTempFile(t, "b"), snapshotPath: "b", size: 20},
	}
	var got []int64
	restore := setProgressThrottleForTest(0) // emit every file in tests
	defer restore()
	_, err := createSnapshotWithProgress(context.Background(), p, files,
		func(fd, ft int, bd, bt int64) { got = append(got, bd) }, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 || got[len(got)-1] != 30 {
		t.Fatalf("want final bytesDone=30, got %v", got)
	}
}

// writeTempFile writes content to a fresh temp file and returns its path.
func writeTempFile(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	p := pathpkg.Join(dir, "file")
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write temp file: %v", err)
	}
	return p
}

func TestUploadDeadline(t *testing.T) {
	restore := setUploadTimeoutFloorForTest(5 * time.Minute)
	defer restore()

	tests := []struct {
		name string
		size int64
		want time.Duration
	}{
		{"zero size uses floor", 0, 5 * time.Minute},
		{"small file uses floor", 1024, 5 * time.Minute},
		{"just under floor-equivalent bytes uses floor", uploadMinThroughputBps * 299, 5 * time.Minute},
		{"large file scales past floor", uploadMinThroughputBps * 600, 600 * time.Second},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := uploadDeadline(tt.size); got != tt.want {
				t.Errorf("uploadDeadline(%d) = %v, want %v", tt.size, got, tt.want)
			}
		})
	}
}

func TestPerFileUploadTimeoutDoesNotAbortJob(t *testing.T) {
	// stallOnceProvider: every UploadContext call for the first file it sees
	// blocks until ctx.Done() then returns ctx.Err() (so the file stalls on
	// both the initial attempt and its retry); the other file succeeds
	// immediately.
	p := &stallOnceProvider{}
	files := []backupFile{
		{sourcePath: writeTempFile(t, "a"), snapshotPath: "a", size: 1},
		{sourcePath: writeTempFile(t, "b"), snapshotPath: "b", size: 1},
	}
	restoreFloor := setUploadTimeoutFloorForTest(50 * time.Millisecond) // test seam, see Step 3
	defer restoreFloor()
	restoreDelay := setUploadRetryDelayForTest(0) // don't wait out the real backoff before the retry
	defer restoreDelay()

	snap, err := CreateSnapshotContext(context.Background(), p, files)
	if err != nil {
		t.Fatalf("job aborted, want per-file skip: %v", err)
	}
	if len(snap.Files) != 1 {
		t.Fatalf("want 1 uploaded file (one timed out), got %d", len(snap.Files))
	}
}

// failOnceProvider fails the first UploadContext call for each distinct
// localPath with a plain (non-cancel) error, then succeeds on every
// subsequent call for that same path. It models a transient per-file upload
// error that clears up on retry. The manifest upload (identified by its
// remotePath suffix) always succeeds unconditionally — it is not part of
// what this double is exercising, and it never gets a retry by design.
type failOnceProvider struct {
	mu     sync.Mutex
	calls  map[string]int
	failed map[string]bool
}

func newFailOnceProvider() *failOnceProvider {
	return &failOnceProvider{
		calls:  make(map[string]int),
		failed: make(map[string]bool),
	}
}

func (p *failOnceProvider) Upload(localPath, remotePath string) error {
	return p.UploadContext(context.Background(), localPath, remotePath)
}

func (p *failOnceProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	if strings.HasSuffix(remotePath, snapshotManifestKey) {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls[localPath]++
	if !p.failed[localPath] {
		p.failed[localPath] = true
		return errors.New("transient upload error")
	}
	return nil
}

func (p *failOnceProvider) callCount(localPath string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls[localPath]
}

func (p *failOnceProvider) Download(remotePath, localPath string) error { return nil }
func (p *failOnceProvider) List(prefix string) ([]string, error)        { return nil, nil }
func (p *failOnceProvider) Delete(remotePath string) error              { return nil }

func TestPerFileUploadRetry_SucceedsOnSecondAttempt(t *testing.T) {
	p := newFailOnceProvider()
	sourcePath := writeTempFile(t, "a")
	files := []backupFile{
		{sourcePath: sourcePath, snapshotPath: "a", size: 1},
	}
	restore := setUploadRetryDelayForTest(0) // don't wait out the real backoff
	defer restore()

	snap, err := CreateSnapshotContext(context.Background(), p, files)
	if err != nil {
		t.Fatalf("want nil error once the retry succeeds, got %v", err)
	}
	if len(snap.Files) != 1 {
		t.Fatalf("want 1 uploaded file, got %d", len(snap.Files))
	}
	if got := p.callCount(sourcePath); got != 2 {
		t.Fatalf("want exactly 2 UploadContext calls (initial + one retry), got %d", got)
	}
}

func TestPerFileUploadRetry_CancelDuringFirstAttempt_NoRetry(t *testing.T) {
	// blockingUploadProvider (defined in backup_test.go) blocks its
	// UploadContext call until ctx.Done(), signalling p.started once the
	// call has begun so the test can cancel the job context mid-attempt.
	p := newBlockingUploadProvider()
	files := []backupFile{
		{sourcePath: writeTempFile(t, "a"), snapshotPath: "a", size: 1},
	}
	restore := setUploadRetryDelayForTest(0) // retry must not happen at all; keep any accidental wait short
	defer restore()

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		_, err := CreateSnapshotContext(ctx, p, files)
		errCh <- err
	}()

	select {
	case <-p.started:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for upload to start")
	}
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, errBackupStopped) {
			t.Fatalf("want errBackupStopped, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("snapshot did not unwind after job-context cancel")
	}
}

func TestCreateSnapshot_AllUploadsFail(t *testing.T) {
	restore := setUploadRetryDelayForTest(0) // the failing upload now gets one retry; don't wait out the real backoff
	defer restore()

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

// blockAfterNProvider wraps a mockProvider: the first n UploadContext calls
// delegate straight to the backing provider (so their bytes actually land
// and its uploadCalls/files/deleteCalls stay observable), and the (n+1)th
// call blocks until ctx.Done(), signalling `started` once it begins
// blocking so a test can cancel deterministically mid-run instead of racing
// a real stall. Models "upload N of M files, then get interrupted."
type blockAfterNProvider struct {
	backing *mockProvider
	n       int

	mu      sync.Mutex
	calls   int
	started chan struct{}
	once    sync.Once
}

func newBlockAfterNProvider(backing *mockProvider, n int) *blockAfterNProvider {
	return &blockAfterNProvider{backing: backing, n: n, started: make(chan struct{})}
}

func (p *blockAfterNProvider) Upload(localPath, remotePath string) error {
	return p.UploadContext(context.Background(), localPath, remotePath)
}

func (p *blockAfterNProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	p.mu.Lock()
	call := p.calls
	p.calls++
	p.mu.Unlock()

	if call < p.n {
		return p.backing.Upload(localPath, remotePath)
	}
	p.once.Do(func() { close(p.started) })
	<-ctx.Done()
	return ctx.Err()
}

func (p *blockAfterNProvider) Download(remotePath, localPath string) error {
	return p.backing.Download(remotePath, localPath)
}
func (p *blockAfterNProvider) List(prefix string) ([]string, error) { return p.backing.List(prefix) }
func (p *blockAfterNProvider) Delete(remotePath string) error       { return p.backing.Delete(remotePath) }

// TestCreateSnapshotWithProgress_StopWithoutJournal_CleansUpPrefix pins down
// the OLD stop semantics for the journal==nil case (bare CreateSnapshot/
// CreateSnapshotContext callers, which never pass a journal): a stopped run
// still cleans up its partial remote prefix, exactly as before this task.
func TestCreateSnapshotWithProgress_StopWithoutJournal_CleansUpPrefix(t *testing.T) {
	backing := newMockProvider()
	provider := newBlockAfterNProvider(backing, 1) // 1st file succeeds, 2nd blocks
	files := []backupFile{
		{sourcePath: writeTempFile(t, "a"), snapshotPath: "a", size: 1},
		{sourcePath: writeTempFile(t, "b"), snapshotPath: "b", size: 1},
	}

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		_, err := createSnapshotWithProgress(ctx, provider, files, nil, nil, nil)
		errCh <- err
	}()

	select {
	case <-provider.started:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the 2nd upload to start")
	}
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, errBackupStopped) {
			t.Fatalf("want errBackupStopped, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("snapshot did not unwind after cancel")
	}

	if len(backing.deleteCalls) == 0 {
		t.Fatal("without a journal, a stopped run must still clean up its partial remote prefix (old semantics)")
	}
}

// TestCreateSnapshotWithProgress_StopWithJournal_PreservesPrefixAndJournal
// proves the NEW stop semantics: with an active journal, a stopped run
// leaves the partial remote prefix AND the journal in place — together they
// are the resume state for the next run.
func TestCreateSnapshotWithProgress_StopWithJournal_PreservesPrefixAndJournal(t *testing.T) {
	backing := newMockProvider()
	provider := newBlockAfterNProvider(backing, 1) // 1st file succeeds, 2nd blocks
	files := []backupFile{
		{sourcePath: writeTempFile(t, "a"), snapshotPath: "a", size: 1},
		{sourcePath: writeTempFile(t, "b"), snapshotPath: "b", size: 1},
	}

	journalDir := t.TempDir()
	journal, resumed, err := openSnapshotJournal(journalDir, "test-stop-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	if resumed {
		t.Fatal("a fresh journal should not resume")
	}
	journalPath := journal.path

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		_, err := createSnapshotWithProgress(ctx, provider, files, nil, journal, nil)
		errCh <- err
	}()

	select {
	case <-provider.started:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the 2nd upload to start")
	}
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, errBackupStopped) {
			t.Fatalf("want errBackupStopped, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("snapshot did not unwind after cancel")
	}

	if len(backing.deleteCalls) != 0 {
		t.Fatalf("a journal-active stop must NOT clean up the partial remote prefix, but got deletes: %v", backing.deleteCalls)
	}
	if _, err := os.Stat(journalPath); err != nil {
		t.Fatalf("expected the journal file to remain on disk after a stopped run, stat err = %v", err)
	}

	// Reopening resumes with the one file that succeeded before the stop.
	j2, resumed2, err := openSnapshotJournal(journalDir, "test-stop-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("reopen failed: %v", err)
	}
	if !resumed2 {
		t.Fatal("expected the abandoned journal to resume on reopen")
	}
	if _, ok := j2.Lookup(files[0].sourcePath, files[0].size, files[0].modTime); !ok {
		t.Error("expected the file uploaded before stop to be recorded in the journal")
	}
	j2.Abandon()
}

// TestCreateSnapshotWithProgress_ResumeAfterInterruption is the resume
// integration test: run 1 uploads 2 of 4 files before being interrupted
// (journal retained); run 2 resumes from the same journal and must upload
// exactly the 2 missing files, produce a manifest listing all 4, and reuse
// run 1's snapshot ID.
func TestCreateSnapshotWithProgress_ResumeAfterInterruption(t *testing.T) {
	backing := newMockProvider()
	provider := newBlockAfterNProvider(backing, 2) // 1st 2 files succeed, 3rd blocks
	tmpDir := t.TempDir()
	modTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	files := []backupFile{
		{sourcePath: createTempFile(t, tmpDir, "f1.txt", "one"), snapshotPath: "path_0/f1.txt", size: 3, modTime: modTime},
		{sourcePath: createTempFile(t, tmpDir, "f2.txt", "two"), snapshotPath: "path_0/f2.txt", size: 3, modTime: modTime},
		{sourcePath: createTempFile(t, tmpDir, "f3.txt", "three"), snapshotPath: "path_0/f3.txt", size: 5, modTime: modTime},
		{sourcePath: createTempFile(t, tmpDir, "f4.txt", "four!"), snapshotPath: "path_0/f4.txt", size: 5, modTime: modTime},
	}

	journalDir := t.TempDir()
	identity := "test-resume-identity"
	journal1, resumed1, err := openSnapshotJournal(journalDir, identity, journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	if resumed1 {
		t.Fatal("run 1 should not resume (no prior journal)")
	}

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		_, err := createSnapshotWithProgress(ctx, provider, files, nil, journal1, nil)
		errCh <- err
	}()
	select {
	case <-provider.started:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the 3rd upload to start")
	}
	cancel()
	select {
	case err := <-errCh:
		if !errors.Is(err, errBackupStopped) {
			t.Fatalf("want errBackupStopped from run 1, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("run 1 did not unwind after cancel")
	}

	if len(backing.uploadCalls) != 2 {
		t.Fatalf("expected exactly 2 uploads to have landed before interruption, got %d: %v", len(backing.uploadCalls), backing.uploadCalls)
	}

	// Run 2: reopen the journal for the same identity/dir — must resume.
	journal2, resumed2, err := openSnapshotJournal(journalDir, identity, journalMaxAge)
	if err != nil {
		t.Fatalf("reopen failed: %v", err)
	}
	if !resumed2 {
		t.Fatal("run 2 should resume from run 1's journal")
	}
	if journal2.snapshotID != journal1.snapshotID {
		t.Fatalf("resumed snapshot ID = %q, want %q (same as run 1)", journal2.snapshotID, journal1.snapshotID)
	}

	// A fresh provider standing in for "the same remote store, run 2's
	// perspective" so its uploadCalls exactly capture what run 2 does.
	// Seeded with what run 1 actually wrote so the resumed objects are
	// still really there, mirroring the real (shared) remote destination.
	recording := newMockProvider()
	for k, v := range backing.files {
		recording.files[k] = v
	}

	snapshot2, err := createSnapshotWithProgress(context.Background(), recording, files, nil, journal2, nil)
	if err != nil {
		t.Fatalf("run 2 failed: %v", err)
	}
	if snapshot2.ID != journal1.snapshotID {
		t.Fatalf("run 2 snapshot ID = %q, want %q (resumed)", snapshot2.ID, journal1.snapshotID)
	}
	if len(snapshot2.Files) != 4 {
		t.Fatalf("expected all 4 files in the final manifest, got %d", len(snapshot2.Files))
	}

	// Exactly the 2 missing files were newly uploaded in run 2 (plus the
	// manifest) — f1/f2 were resumed from the journal and skipped.
	if len(recording.uploadCalls) != 3 {
		t.Fatalf("expected exactly 3 new uploads in run 2 (2 missing files + manifest), got %d: %v",
			len(recording.uploadCalls), recording.uploadCalls)
	}
	uploadedBases := map[string]bool{}
	for _, c := range recording.uploadCalls {
		uploadedBases[pathpkg.Base(c.localPath)] = true
	}
	if uploadedBases["f1.txt"] || uploadedBases["f2.txt"] {
		t.Errorf("f1/f2 should have been resumed, not re-uploaded: %v", recording.uploadCalls)
	}
	if !uploadedBases["f3.txt"] || !uploadedBases["f4.txt"] {
		t.Errorf("f3/f4 should have been uploaded in run 2: %v", recording.uploadCalls)
	}

	// Success: the journal is gone.
	if _, err := os.Stat(journal1.path); !os.IsNotExist(err) {
		t.Fatalf("expected the journal to be removed after run 2 completes successfully, stat err = %v", err)
	}
}

// TestCreateSnapshotWithProgress_ChangedFileReuploadsAndSupersedes covers
// the resume-match rule's negative case: a file present in the journal but
// whose (size, modTime) changed since is treated as a miss — re-uploaded,
// not skipped — and its new entry supersedes the old one.
func TestCreateSnapshotWithProgress_ChangedFileReuploadsAndSupersedes(t *testing.T) {
	provider := newMockProvider()
	tmpDir := t.TempDir()
	oldModTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	newModTime := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)

	journalDir := t.TempDir()
	journal, _, err := openSnapshotJournal(journalDir, "test-changed-file", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	if err := journal.Record(SnapshotFile{
		SourcePath: pathpkg.Join(tmpDir, "changed.txt"), Size: 3, ModTime: oldModTime, Checksum: "stale",
	}); err != nil {
		t.Fatalf("Record failed: %v", err)
	}

	// The actual file on disk now has a different size/modTime than what
	// the journal recorded — simulating a file that changed between runs.
	changedPath := createTempFile(t, tmpDir, "changed.txt", "new content")
	files := []backupFile{
		{sourcePath: changedPath, snapshotPath: "path_0/changed.txt", size: int64(len("new content")), modTime: newModTime},
	}

	snapshot, err := createSnapshotWithProgress(context.Background(), provider, files, nil, journal, nil)
	if err != nil {
		t.Fatalf("createSnapshotWithProgress failed: %v", err)
	}
	if len(snapshot.Files) != 1 {
		t.Fatalf("expected 1 file, got %d", len(snapshot.Files))
	}
	if snapshot.Files[0].Checksum == "stale" {
		t.Error("changed file should have been re-uploaded (fresh checksum), not resumed from the stale journal entry")
	}
	if len(provider.uploadCalls) != 2 { // data file + manifest
		t.Fatalf("expected the changed file to actually re-upload, got %d upload calls: %v", len(provider.uploadCalls), provider.uploadCalls)
	}
}

// TestCreateSnapshotWithProgress_JournalRecordFailureDoesNotFailBackup
// proves that a journal write failure degrades to a journal-less checkpoint
// for the rest of the run rather than failing the backup — the upload
// itself already succeeded.
func TestCreateSnapshotWithProgress_JournalRecordFailureDoesNotFailBackup(t *testing.T) {
	provider := newMockProvider()
	files := []backupFile{
		{sourcePath: writeTempFile(t, "a"), snapshotPath: "a", size: 1},
	}

	journalDir := t.TempDir()
	journal, _, err := openSnapshotJournal(journalDir, "test-broken-journal", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	// Simulate a mid-run disk/permission failure: close the underlying file
	// out from under the journal so every subsequent Record fails to write.
	if err := journal.file.Close(); err != nil {
		t.Fatalf("test setup: failed to close journal file: %v", err)
	}

	snapshot, err := createSnapshotWithProgress(context.Background(), provider, files, nil, journal, nil)
	if err != nil {
		t.Fatalf("a broken journal must not fail the backup, got: %v", err)
	}
	if snapshot == nil || len(snapshot.Files) != 1 {
		t.Fatalf("expected the file to still be backed up despite the journal failure, snapshot=%+v", snapshot)
	}
}

// TestCreateSnapshotWithProgress_VSSOriginalPathResumeMatch is FIX A's
// regression test: under VSS, sourcePath is a fresh per-run shadow-copy
// device path, so run 2's sourcePath for the same logical file is NEVER
// equal to run 1's. The journal must key on OriginalPath (the stable,
// pre-rewrite path) instead, or resume silently never matches on
// Windows-with-VSS. Simulated portably — no real VSS/OS calls involved,
// just two backupFile/SnapshotFile values with deliberately different
// sourcePath but the same originalPath/OriginalPath.
func TestCreateSnapshotWithProgress_VSSOriginalPathResumeMatch(t *testing.T) {
	provider := newMockProvider()
	modTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	journalDir := t.TempDir()

	journal1, _, err := openSnapshotJournal(journalDir, "test-vss-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	// What run 1 actually recorded: SourcePath is run 1's shadow-copy
	// device path (ephemeral — a fresh VSS session next run would produce a
	// completely different string), OriginalPath is the stable, real
	// on-disk path.
	if err := journal1.Record(SnapshotFile{
		SourcePath:   "SHADOW-RUN1/data/f.txt",
		OriginalPath: "/data/f.txt",
		BackupPath:   "snap/f.txt.gz",
		Size:         11,
		ModTime:      modTime,
		Checksum:     "run1-checksum",
	}); err != nil {
		t.Fatalf("Record failed: %v", err)
	}
	journal1.Abandon()

	journal2, resumed2, err := openSnapshotJournal(journalDir, "test-vss-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("reopen failed: %v", err)
	}
	if !resumed2 {
		t.Fatal("expected run 2 to resume run 1's journal")
	}

	// Run 2 walks a DIFFERENT (fresh) shadow-copy device path for the same
	// logical file, but the same OriginalPath.
	run2File := backupFile{
		sourcePath:   "SHADOW-RUN2/data/f.txt", // different from run 1's
		originalPath: "/data/f.txt",            // same as run 1's
		snapshotPath: "path_0/f.txt",
		size:         11,
		modTime:      modTime,
	}

	snapshot, err := createSnapshotWithProgress(context.Background(), provider, []backupFile{run2File}, nil, journal2, nil)
	if err != nil {
		t.Fatalf("run 2 failed: %v", err)
	}
	if len(snapshot.Files) != 1 {
		t.Fatalf("expected 1 file, got %d", len(snapshot.Files))
	}
	if snapshot.Files[0].Checksum != "run1-checksum" {
		t.Errorf("expected the resumed (run 1) entry to be carried forward, got %+v", snapshot.Files[0])
	}
	// Only the manifest should have uploaded — the data file itself must be
	// skipped (resumed via OriginalPath), proving the match happened
	// despite run 2's different sourcePath. If this fails with 2 uploads,
	// resume silently regressed to matching on sourcePath again.
	if len(provider.uploadCalls) != 1 {
		t.Fatalf("expected only the manifest to upload (file resumed via OriginalPath), got %d upload calls: %v",
			len(provider.uploadCalls), provider.uploadCalls)
	}
}

// TestCreateSnapshotWithProgress_NonVSSFilesCarryNoOriginalPath is FIX A's
// non-regression test: when VSS is off (the common, non-Windows-or-no-VSS
// case), OriginalPath must stay empty and be omitted from the JSON manifest
// entirely (omitempty) — manifests must be byte-identical to before this
// field existed.
func TestCreateSnapshotWithProgress_NonVSSFilesCarryNoOriginalPath(t *testing.T) {
	provider := newMockProvider()
	files := []backupFile{
		{sourcePath: writeTempFile(t, "plain"), snapshotPath: "a", size: 5}, // originalPath left zero-value
	}

	snapshot, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil)
	if err != nil {
		t.Fatalf("createSnapshotWithProgress failed: %v", err)
	}
	if snapshot.Files[0].OriginalPath != "" {
		t.Errorf("non-VSS file must carry no OriginalPath, got %q", snapshot.Files[0].OriginalPath)
	}
	data, err := json.Marshal(snapshot.Files[0])
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}
	if strings.Contains(string(data), "originalPath") {
		t.Errorf("empty OriginalPath must be omitted from JSON (omitempty), got %s", data)
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

func TestBackupIdentity_DistinguishesDestinations(t *testing.T) {
	providerA := &mockProvider{} // no JournalIdentity — generic per-type fallback
	if got, want := backupIdentity(providerA, []string{"/data"}), "*backup.mockProvider|/data"; got != want {
		t.Errorf("backupIdentity = %q, want %q", got, want)
	}

	// Different configured paths must yield a different identity.
	idA := backupIdentity(providerA, []string{"/data"})
	idB := backupIdentity(providerA, []string{"/other"})
	if idA == idB {
		t.Error("different paths must produce different identities")
	}

	// Path order DOES matter (deliberately order-sensitive — see the
	// backupIdentity doc comment: object naming is positional, so a
	// reordered path list must get a fresh identity/journal rather than
	// resuming under stale index assumptions).
	idOrderFirst := backupIdentity(providerA, []string{"/a", "/b"})
	idOrderSecond := backupIdentity(providerA, []string{"/b", "/a"})
	if idOrderFirst == idOrderSecond {
		t.Error("reordering paths must change the identity (order-sensitive by design)")
	}
	// Same order, called again, must be stable (not e.g. map-iteration flaky).
	if backupIdentity(providerA, []string{"/a", "/b"}) != idOrderFirst {
		t.Error("identity must be stable for the same provider+paths in the same order")
	}

	// A provider implementing JournalIdentity uses its own material instead
	// of the generic per-type fallback.
	local := providers.NewLocalProvider("/tmp/dest-a")
	otherLocal := providers.NewLocalProvider("/tmp/dest-b")
	if backupIdentity(local, []string{"/data"}) == backupIdentity(otherLocal, []string{"/data"}) {
		t.Error("two LocalProviders with different base paths must produce different identities")
	}
}

// TestBackupIdentity_ReorderedPathsDoNotResume is FIX B's regression test:
// a path-list reorder between an interrupted run and its resume must not
// keep resuming under the old identity — that would let a changed file at
// the new index re-upload over an object a resumed (skipped) journal entry
// still references, corrupting that entry's manifest mapping (object naming
// is positional: path_%d). A fresh identity means a fresh journal, so
// nothing in the old journal can wrongly match.
func TestBackupIdentity_ReorderedPathsDoNotResume(t *testing.T) {
	provider := newMockProvider()
	dir := t.TempDir()

	run1Identity := backupIdentity(provider, []string{"/data/a", "/data/b"})
	journal1, resumed1, err := openSnapshotJournal(dir, run1Identity, journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	if resumed1 {
		t.Fatal("run 1 should not resume")
	}
	if err := journal1.Record(SnapshotFile{SourcePath: "/data/a/f.txt", Size: 1, ModTime: time.Now()}); err != nil {
		t.Fatalf("Record failed: %v", err)
	}
	journal1.Abandon()

	// Run 2: the same two paths, but reordered.
	run2Identity := backupIdentity(provider, []string{"/data/b", "/data/a"})
	journal2, resumed2, err := openSnapshotJournal(dir, run2Identity, journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	if resumed2 {
		t.Fatal("a reordered path list must not resume run 1's journal")
	}
	if journal2.snapshotID == journal1.snapshotID {
		t.Fatal("a reordered path list must get a fresh snapshot ID, not run 1's")
	}
	journal2.Abandon()
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

// releasableUploadProvider blocks every UploadContext call until release is
// closed (or the passed context is done), then succeeds immediately — used to
// model a single very long in-flight upload.
type releasableUploadProvider struct {
	release chan struct{}
}

func (p *releasableUploadProvider) Upload(localPath, remotePath string) error {
	return p.UploadContext(context.Background(), localPath, remotePath)
}

func (p *releasableUploadProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	select {
	case <-p.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *releasableUploadProvider) Download(remotePath, localPath string) error { return nil }
func (p *releasableUploadProvider) List(prefix string) ([]string, error)        { return nil, nil }
func (p *releasableUploadProvider) Delete(remotePath string) error              { return nil }

// Regression test for the reaper-vs-long-upload deadlock: the upload loop
// only emits progress after each COMPLETED file, so a single file whose
// upload takes longer than the server's stale-progress window used to look
// dead server-side and get killed mid-upload, forever. The keepalive
// goroutine must re-emit the CURRENT counters WHILE an upload is still in
// flight. Run with -race: the keepalive goroutine and the upload loop share
// the progress counters.
func TestSnapshotProgressKeepalive_EmitsDuringInFlightUpload(t *testing.T) {
	restoreThrottle := setProgressThrottleForTest(0)
	defer restoreThrottle()
	restoreKeepalive := setProgressKeepaliveIntervalForTest(10 * time.Millisecond)
	defer restoreKeepalive()

	release := make(chan struct{})
	provider := &releasableUploadProvider{release: release}
	files := []backupFile{
		{sourcePath: writeTempFile(t, "payload"), snapshotPath: "a", size: 7, modTime: time.Now()},
	}

	type emission struct {
		filesDone, filesTotal int
		bytesDone, bytesTotal int64
	}
	progressed := make(chan emission, 64)
	done := make(chan error, 1)
	go func() {
		_, err := createSnapshotWithProgress(context.Background(), provider, files,
			func(fd, ft int, bd, bt int64) {
				select {
				case progressed <- emission{fd, ft, bd, bt}:
				default:
				}
			}, nil, nil)
		done <- err
	}()

	// A keepalive emission must arrive WHILE the (only) upload is blocked —
	// i.e. before we release the provider — carrying the unchanged counters.
	select {
	case got := <-progressed:
		if got.filesDone != 0 || got.bytesDone != 0 {
			t.Fatalf("in-flight keepalive must report unchanged counters, got filesDone=%d bytesDone=%d", got.filesDone, got.bytesDone)
		}
		if got.filesTotal != 1 || got.bytesTotal != 7 {
			t.Fatalf("keepalive must report the known totals, got filesTotal=%d bytesTotal=%d", got.filesTotal, got.bytesTotal)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no keepalive progress emission while the upload was in flight")
	}

	close(release)
	if err := <-done; err != nil {
		t.Fatalf("snapshot should complete after the upload is released: %v", err)
	}
}

// Partial success must carry the per-file failures out on the snapshot (see
// Snapshot.UploadFailures) instead of silently dropping them — they used to
// be returned only when ZERO files uploaded.
func TestCreateSnapshot_PartialFailureRecordsUploadFailures(t *testing.T) {
	restore := setUploadRetryDelayForTest(0)
	defer restore()

	tmpDir := t.TempDir()
	good := createTempFile(t, tmpDir, "good.txt", "good content")

	failProvider := &failingUploadProvider{
		backingProvider: newMockProvider(),
		failOn:          -1, // never fail by call count; the bad source path fails on read
	}
	files := []backupFile{
		{sourcePath: good, snapshotPath: "path_0/good.txt", size: 12, modTime: time.Now()},
		{sourcePath: pathpkg.Join(tmpDir, "missing.txt"), snapshotPath: "path_0/missing.txt", size: 5, modTime: time.Now()},
	}

	snapshot, err := CreateSnapshot(failProvider, files)
	if err != nil {
		t.Fatalf("partial success must not return an error, got: %v", err)
	}
	if snapshot == nil {
		t.Fatal("snapshot should not be nil for partial success")
	}
	if len(snapshot.UploadFailures) != 1 {
		t.Fatalf("expected 1 recorded upload failure, got %d: %v", len(snapshot.UploadFailures), snapshot.UploadFailures)
	}
	if !strings.Contains(snapshot.UploadFailures[0].Error(), "missing.txt") {
		t.Fatalf("upload failure should name the failed file, got: %v", snapshot.UploadFailures[0])
	}
	// The manifest must never carry the in-memory failure list.
	data, marshalErr := json.Marshal(snapshot)
	if marshalErr != nil {
		t.Fatalf("marshal snapshot: %v", marshalErr)
	}
	if strings.Contains(string(data), `"UploadFailures":`) || strings.Contains(string(data), `"uploadFailures":`) {
		t.Fatalf("UploadFailures must not serialize into the manifest: %s", data)
	}
}

// TestCreateSnapshotWithProgress_IncrementalTwoRun_ReferencesUnchangedFiles
// is the incremental-backup integration test: run 1 uploads 3 files in
// full; between runs, one file (f2) is mutated and one (f3) is deleted from
// disk entirely. Run 2, fed run 1's manifest via previousManifest, must
// upload exactly the changed file, reference the unchanged one (pointing
// at run 1's prefix, no re-upload), and the deleted file must be absent
// from the new manifest with no tombstone.
func TestCreateSnapshotWithProgress_IncrementalTwoRun_ReferencesUnchangedFiles(t *testing.T) {
	provider := newMockProvider()
	tmpDir := t.TempDir()
	modTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	f1 := createTempFile(t, tmpDir, "f1.txt", "one")
	f2 := createTempFile(t, tmpDir, "f2.txt", "two")
	f3 := createTempFile(t, tmpDir, "f3.txt", "three")
	for _, p := range []string{f1, f2, f3} {
		if err := os.Chtimes(p, modTime, modTime); err != nil {
			t.Fatalf("test setup: Chtimes(%s) failed: %v", p, err)
		}
	}

	run1Files := []backupFile{
		{sourcePath: f1, snapshotPath: "path_0/f1.txt", size: 3, modTime: modTime},
		{sourcePath: f2, snapshotPath: "path_0/f2.txt", size: 3, modTime: modTime},
		{sourcePath: f3, snapshotPath: "path_0/f3.txt", size: 5, modTime: modTime},
	}
	snapshot1, err := createSnapshotWithProgress(context.Background(), provider, run1Files, nil, nil, nil)
	if err != nil {
		t.Fatalf("run 1 failed: %v", err)
	}
	if snapshot1.FormatVersion != 0 || snapshot1.BaseSnapshotID != "" {
		t.Fatalf("run 1 (no previous manifest) must not set FormatVersion/BaseSnapshotID, got %+v", snapshot1)
	}
	if len(provider.uploadCalls) != 4 { // 3 files + manifest
		t.Fatalf("run 1: expected 4 uploads, got %d: %v", len(provider.uploadCalls), provider.uploadCalls)
	}

	// Mutate f2's content+modTime between runs; delete f3 entirely
	// (simulating a file removed from disk before run 2's walk — it must
	// end up absent from the new manifest, no tombstone).
	newModTime := modTime.Add(time.Hour)
	if err := os.WriteFile(f2, []byte("TWO-CHANGED"), 0644); err != nil {
		t.Fatalf("failed to mutate f2: %v", err)
	}
	if err := os.Chtimes(f2, newModTime, newModTime); err != nil {
		t.Fatalf("failed to touch f2: %v", err)
	}
	if err := os.Remove(f3); err != nil {
		t.Fatalf("failed to remove f3: %v", err)
	}

	provider.uploadCalls = nil // isolate run 2's upload assertions

	prev, reason := previousManifest(context.Background(), provider)
	if prev == nil {
		t.Fatalf("expected a usable previous manifest for run 2, got none: %s", reason)
	}
	if prev.ID != snapshot1.ID {
		t.Fatalf("previousManifest returned %q, want run 1's snapshot %q", prev.ID, snapshot1.ID)
	}

	run2Files := []backupFile{
		{sourcePath: f1, snapshotPath: "path_0/f1.txt", size: 3, modTime: modTime},                            // unchanged
		{sourcePath: f2, snapshotPath: "path_0/f2.txt", size: int64(len("TWO-CHANGED")), modTime: newModTime}, // changed
		// f3 deliberately absent — deleted from disk before this run's walk.
	}
	snapshot2, err := createSnapshotWithProgress(context.Background(), provider, run2Files, nil, nil, prev)
	if err != nil {
		t.Fatalf("run 2 failed: %v", err)
	}

	if snapshot2.FormatVersion != 2 {
		t.Errorf("run 2 FormatVersion = %d, want 2 (a previous manifest was used)", snapshot2.FormatVersion)
	}
	if snapshot2.BaseSnapshotID != snapshot1.ID {
		t.Errorf("run 2 BaseSnapshotID = %q, want %q", snapshot2.BaseSnapshotID, snapshot1.ID)
	}

	// Exactly 1 data upload (f2, changed) + manifest = 2 uploads.
	if len(provider.uploadCalls) != 2 {
		t.Fatalf("run 2: expected exactly 2 uploads (1 changed file + manifest), got %d: %v", len(provider.uploadCalls), provider.uploadCalls)
	}
	uploadedBases := map[string]bool{}
	for _, c := range provider.uploadCalls {
		uploadedBases[pathpkg.Base(c.localPath)] = true
	}
	if !uploadedBases["f2.txt"] {
		t.Errorf("f2 (changed) should have been uploaded: %v", provider.uploadCalls)
	}
	if uploadedBases["f1.txt"] {
		t.Errorf("f1 (unchanged) should have been referenced, not re-uploaded: %v", provider.uploadCalls)
	}

	// Manifest lists exactly f1 (referenced) + f2 (uploaded) — f3 is gone,
	// no tombstone.
	if len(snapshot2.Files) != 2 {
		t.Fatalf("expected 2 files in run 2's manifest, got %d: %+v", len(snapshot2.Files), snapshot2.Files)
	}
	bySource := map[string]SnapshotFile{}
	for _, f := range snapshot2.Files {
		bySource[f.SourcePath] = f
	}
	if _, ok := bySource[f3]; ok {
		t.Errorf("deleted file f3 must be absent from run 2's manifest (no tombstone), got %+v", snapshot2.Files)
	}
	f1Entry, ok := bySource[f1]
	if !ok {
		t.Fatalf("f1 missing from run 2's manifest: %+v", snapshot2.Files)
	}
	// f1's BackupPath must point under run 1's prefix (a reference) — proof
	// that restore/verify need zero changes, since BackupPath is absolute.
	if !strings.HasPrefix(f1Entry.BackupPath, path.Join(snapshotRootDir, snapshot1.ID)+"/") {
		t.Errorf("referenced f1's BackupPath = %q, want it under run 1's prefix %q", f1Entry.BackupPath, snapshot1.ID)
	}
	f2Entry, ok := bySource[f2]
	if !ok {
		t.Fatalf("f2 missing from run 2's manifest: %+v", snapshot2.Files)
	}
	if !strings.HasPrefix(f2Entry.BackupPath, path.Join(snapshotRootDir, snapshot2.ID)+"/") {
		t.Errorf("uploaded f2's BackupPath = %q, want it under run 2's own prefix %q", f2Entry.BackupPath, snapshot2.ID)
	}

	// isReferenceEntry (what RunBackupContext uses to derive
	// ReferencedFiles/ReferencedBytes) must agree: f1 is a reference, f2 is
	// not.
	if !isReferenceEntry(f1Entry, snapshot2.ID) {
		t.Error("isReferenceEntry(f1) = false, want true")
	}
	if isReferenceEntry(f2Entry, snapshot2.ID) {
		t.Error("isReferenceEntry(f2) = true, want false")
	}
}

// TestIncrementalBackup_FetchFailureFallsBackToFullRun proves the fail-open
// contract end-to-end: a provider whose List errors makes previousManifest
// return nil, and feeding that nil into createSnapshotWithProgress produces
// an ordinary full run — every file uploads, FormatVersion/BaseSnapshotID
// stay at their zero values, exactly as if incremental backups didn't
// exist.
func TestIncrementalBackup_FetchFailureFallsBackToFullRun(t *testing.T) {
	provider := newMockProvider()
	files := []backupFile{
		{sourcePath: writeTempFile(t, "a"), snapshotPath: "a", size: 1},
		{sourcePath: writeTempFile(t, "b"), snapshotPath: "b", size: 1},
	}

	// Simulate a broken destination for the previous-manifest fetch only.
	provider.listErr = errors.New("simulated list failure")
	prev, reason := previousManifest(context.Background(), provider)
	if prev != nil {
		t.Fatalf("expected nil previous manifest on a list failure, got %+v", prev)
	}
	if reason == "" {
		t.Error("expected a non-empty reason")
	}
	provider.listErr = nil // the run itself must still be able to list/delete normally

	snapshot, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, prev)
	if err != nil {
		t.Fatalf("full-run fallback failed: %v", err)
	}
	if snapshot.FormatVersion != 0 {
		t.Errorf("FormatVersion = %d, want 0 (no previous manifest was used)", snapshot.FormatVersion)
	}
	if snapshot.BaseSnapshotID != "" {
		t.Errorf("BaseSnapshotID = %q, want empty", snapshot.BaseSnapshotID)
	}
	if len(snapshot.Files) != 2 {
		t.Fatalf("expected both files in the manifest, got %d", len(snapshot.Files))
	}
	if len(provider.uploadCalls) != 3 { // 2 files + manifest, nothing referenced
		t.Fatalf("expected all files to actually upload (no dedupe), got %d upload calls: %v", len(provider.uploadCalls), provider.uploadCalls)
	}
}

// TestCreateSnapshotWithProgress_JournalResumeWinsOverReference proves the
// priority rule when the SAME file matches both this run's own (resumed)
// journal AND a DIFFERENT, older snapshot's reference index: the journal
// wins. The journal represents an object this run itself already uploaded
// (a prior, interrupted attempt at the very same snapshot ID) and is
// authoritative for it; the reference index only offers to point at an
// older snapshot's object instead — see createSnapshotWithProgress's doc
// comment for why the journal check runs first in the loop.
func TestCreateSnapshotWithProgress_JournalResumeWinsOverReference(t *testing.T) {
	tmpDir := t.TempDir()
	modTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	filePath := createTempFile(t, tmpDir, "f.txt", "content")

	journalDir := t.TempDir()
	journal, _, err := openSnapshotJournal(journalDir, "test-journal-vs-reference", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	if err := journal.Record(SnapshotFile{
		SourcePath: filePath,
		BackupPath: path.Join(snapshotRootDir, journal.snapshotID, snapshotFilesDir, "path_0/f.txt.gz"),
		Size:       int64(len("content")),
		ModTime:    modTime,
		Checksum:   "journal-checksum",
	}); err != nil {
		t.Fatalf("Record failed: %v", err)
	}

	// A DIFFERENT, older snapshot's manifest also has a matching entry
	// (same size/modTime) for the same logical file, offering a reference.
	prevSnapshot := &Snapshot{
		ID: "snapshot-older",
		Files: []SnapshotFile{
			{SourcePath: filePath, BackupPath: "snapshots/snapshot-older/files/f.txt.gz", Size: int64(len("content")), ModTime: modTime, Checksum: "reference-checksum"},
		},
	}

	provider := newMockProvider()
	files := []backupFile{{sourcePath: filePath, snapshotPath: "path_0/f.txt", size: int64(len("content")), modTime: modTime}}

	snapshot, err := createSnapshotWithProgress(context.Background(), provider, files, nil, journal, prevSnapshot)
	if err != nil {
		t.Fatalf("createSnapshotWithProgress failed: %v", err)
	}
	if len(snapshot.Files) != 1 {
		t.Fatalf("expected 1 file, got %d", len(snapshot.Files))
	}
	if snapshot.Files[0].Checksum != "journal-checksum" {
		t.Errorf("expected the journal's entry to win over the reference, got checksum %q (want journal-checksum)", snapshot.Files[0].Checksum)
	}
	if len(provider.uploadCalls) != 1 { // only the manifest uploads
		t.Fatalf("expected only the manifest to upload (file resumed via journal), got %d upload calls: %v", len(provider.uploadCalls), provider.uploadCalls)
	}
}
