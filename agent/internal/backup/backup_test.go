package backup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	pathpkg "path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

type blockingUploadProvider struct {
	once    sync.Once
	started chan struct{}
}

func newBlockingUploadProvider() *blockingUploadProvider {
	return &blockingUploadProvider{
		started: make(chan struct{}),
	}
}

func (p *blockingUploadProvider) Upload(localPath, remotePath string) error {
	return p.UploadContext(context.Background(), localPath, remotePath)
}

func (p *blockingUploadProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	p.once.Do(func() {
		close(p.started)
	})
	<-ctx.Done()
	return ctx.Err()
}

func (p *blockingUploadProvider) Download(remotePath, localPath string) error {
	return nil
}

func (p *blockingUploadProvider) List(prefix string) ([]string, error) {
	return []string{}, nil
}

func (p *blockingUploadProvider) Delete(remotePath string) error {
	return nil
}

func TestNewBackupManager(t *testing.T) {
	provider := newMockProvider()
	config := BackupConfig{
		Provider:  provider,
		Paths:     []string{"/tmp/data"},
		Retention: 5,
	}

	mgr := NewBackupManager(config)
	if mgr == nil {
		t.Fatal("NewBackupManager returned nil")
	}
	if mgr.config.Provider != provider {
		t.Error("provider not stored correctly")
	}
	if mgr.config.Retention != 5 {
		t.Errorf("retention = %d, want 5", mgr.config.Retention)
	}
}

func TestGetProvider(t *testing.T) {
	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{Provider: provider})
	if mgr.GetProvider() != provider {
		t.Error("GetProvider did not return configured provider")
	}
}

func TestGetProvider_Nil(t *testing.T) {
	mgr := NewBackupManager(BackupConfig{})
	if mgr.GetProvider() != nil {
		t.Error("GetProvider should return nil when no provider configured")
	}
}

func TestStop_NoActiveJob(t *testing.T) {
	mgr := NewBackupManager(BackupConfig{})
	if mgr.Stop() {
		t.Error("Stop should report false when no backup job is running")
	}
}

// Backups are server-scheduled and dispatched as backup_run commands, so the
// only thing Stop has to unwind is an in-flight on-demand job (#2452).
func TestStop_CancelsActiveBackup(t *testing.T) {
	tmpDir := t.TempDir()
	createTempFile(t, tmpDir, "data.txt", "cancel me")

	provider := newBlockingUploadProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider: provider,
		Paths:    []string{tmpDir},
	})

	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		_, _ = mgr.RunBackup()
	}()

	select {
	case <-provider.started:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for backup upload to start")
	}

	if !mgr.Stop() {
		t.Fatal("Stop should report that an active backup was stopped")
	}

	select {
	case <-runDone:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the cancelled backup to unwind")
	}

	// A second Stop is a no-op once the job has unwound.
	if mgr.Stop() {
		t.Error("Stop should report false after the active backup has already stopped")
	}
}

// A server-dispatched backup_run builds an ephemeral BackupManager from the
// command payload; it never goes through Stop() (the helper cancels it via
// commandCanceller instead — see main.go's backup_run/backup_stop cases). So
// the caller-supplied context, not just Stop(), must be able to unwind an
// in-flight run.
func TestRunBackupContextExternalCancel(t *testing.T) {
	provider := newBlockingUploadProvider()
	dir := t.TempDir()
	createTempFile(t, dir, "f.txt", "x")

	mgr := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{dir}})

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		_, err := mgr.RunBackupContext(ctx, nil)
		errCh <- err
	}()

	select {
	case <-provider.started:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for backup upload to start")
	}
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, errBackupStopped) {
			t.Fatalf("want errBackupStopped, got %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("backup did not unwind after external cancel")
	}

	// jobRunning must be cleared after the cancelled run unwinds, or every
	// subsequent RunBackupContext call would wrongly fail with "backup
	// already running". Use an already-cancelled context for the follow-up
	// call so it unwinds at the first ctx.Err() check (before touching the
	// blocking provider again) instead of hanging — we only care whether it
	// got past the jobRunning guard.
	followUpCtx, followUpCancel := context.WithCancel(context.Background())
	followUpCancel()
	if _, err := mgr.RunBackupContext(followUpCtx, nil); err != nil && err.Error() == "backup already running" {
		t.Fatal("jobRunning flag not cleared after cancelled run")
	}
}

// TestRunBackupContext_StopPreservesRemotePrefixAndJournal exercises the
// checkpoint journal through the full manager wiring (RunBackupContext
// opens the real journal via GetStagingDir()+backupIdentity, not a
// hand-built one): a stopped run must leave both the partial remote prefix
// and the on-disk journal file in place.
func TestRunBackupContext_StopPreservesRemotePrefixAndJournal(t *testing.T) {
	backing := newMockProvider()
	provider := newBlockAfterNProvider(backing, 1) // 1st file succeeds, 2nd blocks
	dir := t.TempDir()
	createTempFile(t, dir, "a.txt", "one")
	createTempFile(t, dir, "b.txt", "two")
	stagingDir := t.TempDir()

	mgr := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{dir}, StagingDir: stagingDir})

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		_, err := mgr.RunBackupContext(ctx, nil)
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
	case <-time.After(10 * time.Second):
		t.Fatal("backup did not unwind after cancel")
	}

	if len(backing.deleteCalls) != 0 {
		t.Errorf("stop with an active journal must not clean up the partial remote prefix, deletes=%v", backing.deleteCalls)
	}

	entries, err := os.ReadDir(stagingDir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	found := false
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "backup-journal-") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected a checkpoint journal file to remain in the staging dir after a stopped run, entries=%v", entries)
	}
}

// TestRunBackupContext_StaleJournalCleansUpRemotePrefixAndRunsFresh proves
// the full manager-level wiring for the stale-journal path: a journal older
// than journalMaxAge is discarded, its remote prefix is best-effort cleaned
// up, and the run proceeds fresh with a brand new snapshot ID.
func TestRunBackupContext_StaleJournalCleansUpRemotePrefixAndRunsFresh(t *testing.T) {
	restoreMaxAge := setJournalMaxAgeForTest(time.Millisecond)
	defer restoreMaxAge()

	provider := newMockProvider()
	stagingDir := t.TempDir()
	tmpDir := t.TempDir()
	createTempFile(t, tmpDir, "data.txt", "hello")

	mgr := NewBackupManager(BackupConfig{
		Provider:   provider,
		Paths:      []string{tmpDir},
		StagingDir: stagingDir,
	})

	// Seed a journal for the exact identity RunBackupContext will compute,
	// using a real (non-shrunk) maxAge so seeding it doesn't itself race the
	// staleness check.
	identity := backupIdentity(provider, []string{tmpDir})
	staleJournal, _, err := openSnapshotJournal(stagingDir, identity, time.Hour)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	if err := staleJournal.Record(SnapshotFile{SourcePath: "/gone.txt", Size: 1, ModTime: time.Now()}); err != nil {
		t.Fatalf("Record failed: %v", err)
	}
	staleSnapshotID := staleJournal.snapshotID
	staleJournal.Abandon()

	// Seed the "remote" with an object under the stale snapshot's prefix so
	// cleanup has something observable to delete.
	provider.files[path.Join(snapshotRootDir, staleSnapshotID, snapshotFilesDir, "orphan.gz")] = []byte("orphan")

	time.Sleep(2 * time.Millisecond) // the journal is now older than the shrunk maxAge

	job, err := mgr.RunBackup()
	if err != nil {
		t.Fatalf("RunBackup failed: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("job.Status = %q, want %q", job.Status, jobStatusCompleted)
	}
	if job.Snapshot == nil {
		t.Fatal("expected a completed snapshot")
	}
	if job.Snapshot.ID == staleSnapshotID {
		t.Fatal("a stale journal must never resume the old snapshot ID")
	}

	found := false
	for _, key := range provider.deleteCalls {
		if strings.Contains(key, staleSnapshotID) {
			found = true
		}
	}
	if !found {
		t.Errorf("expected the stale snapshot's remote prefix to be cleaned up, deletes=%v", provider.deleteCalls)
	}
}

// TestOriginalPathsForVSS_ReconstructsOriginalPath tests the FIX-A
// mechanism portably (originalPathsForVSS is pure string manipulation, no
// OS/VSS calls) using OS-neutral fake paths built from filepath.Separator
// rather than literal Windows backslashes, so it exercises the same logic
// identically regardless of which OS runs the test.
func TestOriginalPathsForVSS_ReconstructsOriginalPath(t *testing.T) {
	sep := string(pathpkg.Separator)
	shadowRoot := "SHADOWROOT"
	shadowPaths := map[string]string{
		"VOL:": shadowRoot,
	}
	files := []backupFile{
		{sourcePath: shadowRoot + sep + "Users" + sep + "data" + sep + "f.txt"},
		{sourcePath: shadowRoot},                                 // exact shadow-root match (single-file root case)
		{sourcePath: "SOMETHINGELSE" + sep + "not-shadowed.txt"}, // not under any known shadow root
	}
	originalPathsForVSS(files, shadowPaths)

	if want := "VOL:" + sep + "Users" + sep + "data" + sep + "f.txt"; files[0].originalPath != want {
		t.Errorf("originalPath = %q, want %q", files[0].originalPath, want)
	}
	if want := "VOL:"; files[1].originalPath != want {
		t.Errorf("originalPath = %q, want %q (exact shadow-root match)", files[1].originalPath, want)
	}
	if files[2].originalPath != "" {
		t.Errorf("a file not under any known shadow root must keep an empty originalPath, got %q", files[2].originalPath)
	}
}

func TestOriginalPathsForVSS_NoOpWhenNoShadowPaths(t *testing.T) {
	files := []backupFile{{sourcePath: "/data/f.txt"}}
	originalPathsForVSS(files, nil) // VSS off — the normal, non-Windows case
	if files[0].originalPath != "" {
		t.Errorf("originalPath must stay empty when VSS is off, got %q", files[0].originalPath)
	}
}

func TestRunBackup_NilProvider(t *testing.T) {
	mgr := NewBackupManager(BackupConfig{
		Paths: []string{"/tmp/data"},
	})
	_, err := mgr.RunBackup()
	if err == nil {
		t.Fatal("RunBackup should fail with nil provider")
	}
	if !strings.Contains(err.Error(), "backup provider is required") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRunBackup_NoPaths(t *testing.T) {
	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider: provider,
	})
	_, err := mgr.RunBackup()
	if err == nil {
		t.Fatal("RunBackup should fail with no paths")
	}
	if !strings.Contains(err.Error(), "backup paths are required") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRunBackup_EmptyPaths(t *testing.T) {
	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider: provider,
		Paths:    []string{},
	})
	_, err := mgr.RunBackup()
	if err == nil {
		t.Fatal("RunBackup should fail with empty paths")
	}
}

func TestRunBackup_SingleFile(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "single.txt", "single file backup")

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider: provider,
		Paths:    []string{file1},
	})

	job, err := mgr.RunBackup()
	if err != nil {
		t.Fatalf("RunBackup failed: %v", err)
	}
	if job == nil {
		t.Fatal("job is nil")
	}
	if job.Status != jobStatusCompleted {
		t.Errorf("job status = %q, want %q", job.Status, jobStatusCompleted)
	}
	if job.FilesBackedUp != 1 {
		t.Errorf("files backed up = %d, want 1", job.FilesBackedUp)
	}
	if job.BytesBackedUp <= 0 {
		t.Errorf("bytes backed up = %d, expected > 0", job.BytesBackedUp)
	}
	if job.ID == "" {
		t.Error("job ID should not be empty")
	}
	if job.StartedAt.IsZero() {
		t.Error("job StartedAt should not be zero")
	}
	if job.CompletedAt.IsZero() {
		t.Error("job CompletedAt should not be zero")
	}
	if job.Snapshot == nil {
		t.Error("job Snapshot should not be nil")
	}
}

func TestRunBackup_Directory(t *testing.T) {
	tmpDir := t.TempDir()
	subDir := pathpkg.Join(tmpDir, "backup_data")
	if err := os.MkdirAll(subDir, 0755); err != nil {
		t.Fatalf("failed to create subdir: %v", err)
	}
	createTempFile(t, subDir, "a.txt", "file a")
	createTempFile(t, subDir, "b.txt", "file b")
	nested := pathpkg.Join(subDir, "nested")
	if err := os.MkdirAll(nested, 0755); err != nil {
		t.Fatalf("failed to create nested dir: %v", err)
	}
	createTempFile(t, nested, "c.txt", "file c")

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider: provider,
		Paths:    []string{subDir},
	})

	job, err := mgr.RunBackup()
	if err != nil {
		t.Fatalf("RunBackup failed: %v", err)
	}
	if job.FilesBackedUp != 3 {
		t.Errorf("files backed up = %d, want 3", job.FilesBackedUp)
	}
	if job.Status != jobStatusCompleted {
		t.Errorf("job status = %q, want %q", job.Status, jobStatusCompleted)
	}
}

func TestRunBackup_SystemStateDoesNotMutateConfiguredPaths(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "single.txt", "single file backup")

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider:           provider,
		Paths:              []string{file1},
		SystemStateEnabled: true,
	})

	_, err := mgr.RunBackup()
	if err != nil {
		t.Fatalf("RunBackup failed: %v", err)
	}

	if got := len(mgr.config.Paths); got != 1 {
		t.Fatalf("configured paths len = %d, want 1", got)
	}
	if mgr.config.Paths[0] != file1 {
		t.Fatalf("configured path = %q, want %q", mgr.config.Paths[0], file1)
	}
}

// stubCollectSystemState swaps the package-level collector seam for the test
// and restores it on cleanup.
func stubCollectSystemState(t *testing.T, fn func() (*systemstate.SystemStateManifest, string, error)) {
	t.Helper()
	orig := collectSystemState
	t.Cleanup(func() { collectSystemState = orig })
	collectSystemState = fn
}

func TestRunBackup_SystemImage_NoPathsAllowed(t *testing.T) {
	// system_image mode runs with no configured file paths — the collected
	// system-state staging dir is the whole snapshot, so the "backup paths are
	// required" guard must NOT fire.
	stagingDir := t.TempDir()
	if err := os.WriteFile(pathpkg.Join(stagingDir, "services.txt"), []byte("svc"), 0o600); err != nil {
		t.Fatal(err)
	}
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return &systemstate.SystemStateManifest{Platform: "test"}, stagingDir, nil
	})

	mgr := NewBackupManager(BackupConfig{Provider: newMockProvider(), SystemStateEnabled: true})
	job, err := mgr.RunBackup()
	if err != nil {
		t.Fatalf("system-state-only run should succeed with collected artifacts: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("status = %q, want completed", job.Status)
	}
}

func TestRunBackup_SystemImage_CollectionFailureFailsLoud(t *testing.T) {
	// A system-state-only run whose collection fails entirely must fail loudly,
	// not fall through to a green empty snapshot (it has no file paths to fall
	// back on). The bug this guards: silently "protecting nothing".
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return nil, "", fmt.Errorf("forced collection failure")
	})

	mgr := NewBackupManager(BackupConfig{Provider: newMockProvider(), SystemStateEnabled: true})
	job, err := mgr.RunBackup()
	if err == nil {
		t.Fatal("expected failed collection to surface as an error")
	}
	if job == nil || job.Status != jobStatusFailed {
		t.Fatalf("status = %v, want %q", job, jobStatusFailed)
	}
}

func TestRunBackup_SystemImage_EmptyCollectionFailsLoud(t *testing.T) {
	// Collection "succeeded" but produced zero artifacts (empty staging dir) →
	// still a hard failure with a synthetic reason, not a skip.
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return &systemstate.SystemStateManifest{Platform: "test"}, t.TempDir(), nil
	})

	mgr := NewBackupManager(BackupConfig{Provider: newMockProvider(), SystemStateEnabled: true})
	job, err := mgr.RunBackup()
	if err == nil || job == nil || job.Status != jobStatusFailed {
		t.Fatalf("empty system-state collection should fail loudly; got job=%v err=%v", job, err)
	}
	if !strings.Contains(err.Error(), "no artifacts") {
		t.Fatalf("expected synthetic no-artifacts error, got: %v", err)
	}
}

func TestRunBackup_SystemImage_PartialCollectionWarns(t *testing.T) {
	// A partial collection of *optional* classes (certs/iis) still completes,
	// but must surface a warning so a degraded system_image is visible. (A
	// missing *required* class returns an error from the collector and fails the
	// run instead — see TestRunBackup_SystemImage_CollectionFailureFailsLoud.)
	stagingDir := t.TempDir()
	if err := os.WriteFile(pathpkg.Join(stagingDir, "services.txt"), []byte("svc"), 0o600); err != nil {
		t.Fatal(err)
	}
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return &systemstate.SystemStateManifest{
			Platform:        "test",
			Artifacts:       []systemstate.Artifact{{Name: "services", Category: "services"}},
			IncompleteSteps: []string{"certs", "iis"},
		}, stagingDir, nil
	})

	mgr := NewBackupManager(BackupConfig{Provider: newMockProvider(), SystemStateEnabled: true})
	job, err := mgr.RunBackup()
	if err != nil {
		t.Fatalf("partial collection with artifacts should complete: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("status = %q, want completed", job.Status)
	}
	if !strings.Contains(job.Warning, "certs") || !strings.Contains(job.Warning, "incomplete") {
		t.Fatalf("expected incomplete-steps warning, got %q", job.Warning)
	}
}

func TestRunBackup_MultiplePaths(t *testing.T) {
	tmpDir := t.TempDir()
	dir1 := pathpkg.Join(tmpDir, "dir1")
	dir2 := pathpkg.Join(tmpDir, "dir2")
	os.MkdirAll(dir1, 0755)
	os.MkdirAll(dir2, 0755)

	createTempFile(t, dir1, "x.txt", "x")
	createTempFile(t, dir2, "y.txt", "y")

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider: provider,
		Paths:    []string{dir1, dir2},
	})

	job, err := mgr.RunBackup()
	if err != nil {
		t.Fatalf("RunBackup failed: %v", err)
	}
	if job.FilesBackedUp != 2 {
		t.Errorf("files backed up = %d, want 2", job.FilesBackedUp)
	}
}

func TestRunBackup_NonexistentPath(t *testing.T) {
	tmpDir := t.TempDir()
	nonexistent := pathpkg.Join(tmpDir, "does_not_exist")

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider: provider,
		Paths:    []string{nonexistent},
	})

	job, err := mgr.RunBackup()
	// Should return skipped status with error when path doesn't exist
	if err == nil {
		t.Fatal("expected error for nonexistent path")
	}
	if job.Status != jobStatusSkipped {
		t.Errorf("job status = %q, want %q", job.Status, jobStatusSkipped)
	}
}

func TestRunBackup_EmptyDirectory(t *testing.T) {
	tmpDir := t.TempDir()
	emptyDir := pathpkg.Join(tmpDir, "empty")
	os.MkdirAll(emptyDir, 0755)

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider: provider,
		Paths:    []string{emptyDir},
	})

	job, err := mgr.RunBackup()
	// No files found, should be skipped
	if job.Status != jobStatusSkipped {
		t.Errorf("job status = %q, want %q for empty dir", job.Status, jobStatusSkipped)
	}
	_ = err // scan error is optional
}

func TestRunBackup_EmptyStringPath(t *testing.T) {
	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider: provider,
		Paths:    []string{""},
	})

	job, err := mgr.RunBackup()
	if err == nil {
		t.Fatal("expected error for empty string path")
	}
	if job.Status != jobStatusSkipped {
		t.Errorf("job status = %q, want %q", job.Status, jobStatusSkipped)
	}
}

func TestRunBackup_ConcurrentRunsRejected(t *testing.T) {
	tmpDir := t.TempDir()
	createTempFile(t, tmpDir, "data.txt", "concurrent test")

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider: provider,
		Paths:    []string{tmpDir},
	})

	// Lock the job manually
	mgr.mu.Lock()
	mgr.jobRunning = true
	mgr.mu.Unlock()

	_, err := mgr.RunBackup()
	if err == nil {
		t.Fatal("expected error when backup already running")
	}
	if !strings.Contains(err.Error(), "backup already running") {
		t.Fatalf("unexpected error: %v", err)
	}

	// Unlock for cleanup
	mgr.mu.Lock()
	mgr.jobRunning = false
	mgr.mu.Unlock()
}

func TestRunBackup_WithRetention(t *testing.T) {
	tmpDir := t.TempDir()
	filePath := pathpkg.Join(tmpDir, "data.txt")

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider:  provider,
		Paths:     []string{tmpDir},
		Retention: 2,
	})

	// Run backup twice. There is no mtime-cutoff filtering anymore (every
	// snapshot is a complete restore point), so the file is included in both
	// runs regardless of whether it changed between them.
	for i := 0; i < 2; i++ {
		if err := os.WriteFile(filePath, []byte(fmt.Sprintf("retention test run %d", i)), 0644); err != nil {
			t.Fatalf("failed to write file for run %d: %v", i+1, err)
		}

		job, err := mgr.RunBackup()
		if err != nil {
			t.Fatalf("RunBackup #%d failed: %v", i+1, err)
		}
		if job.Status != jobStatusCompleted {
			t.Errorf("RunBackup #%d status = %q, want %q", i+1, job.Status, jobStatusCompleted)
		}
	}
}

// A long-lived manager must produce a COMPLETE restore point on every run,
// not just the files changed since its previous run. Before this mechanism
// was removed, a second snapshot from the same manager against an unmodified
// source dir would come back empty/skipped (mtime-cutoff filtered every file
// out) while still looking like a valid restore point. Assert the second
// snapshot has the same non-zero file count as the first.
func TestRunBackup_SecondSnapshotIncludesUnmodifiedFiles(t *testing.T) {
	tmpDir := t.TempDir()
	createTempFile(t, tmpDir, "data.txt", "incremental test")

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider: provider,
		Paths:    []string{tmpDir},
	})

	job1, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("first RunBackupContext failed: %v", err)
	}
	if job1.Status != jobStatusCompleted {
		t.Fatalf("first backup status = %q, want %q", job1.Status, jobStatusCompleted)
	}
	if job1.FilesBackedUp != 1 {
		t.Fatalf("first backup: files backed up = %d, want 1", job1.FilesBackedUp)
	}

	// Second run against the same, unmodified source dir must be a complete
	// restore point too — same file count, not skipped/empty.
	job2, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("second RunBackupContext failed: %v", err)
	}
	if job2.Status != jobStatusCompleted {
		t.Fatalf("second backup status = %q, want %q", job2.Status, jobStatusCompleted)
	}
	if job2.FilesBackedUp != job1.FilesBackedUp {
		t.Errorf("second backup: files backed up = %d, want %d (same as first run)", job2.FilesBackedUp, job1.FilesBackedUp)
	}
	if job2.FilesBackedUp == 0 {
		t.Error("second backup: files backed up = 0, want non-zero")
	}
}

// Incremental dedupe (now unconditional) carries an unchanged file's bytes
// forward under the OLDEST snapshot's prefix, and every newer manifest
// references back into it. Agent-side retention pruning deletes an expired
// snapshot's ENTIRE prefix with zero reference-awareness — so pruning the
// oldest prefix while newer manifests still reference it turns every retained
// snapshot into an unrestorable manifest of dangling references (a failure
// that only surfaces at restore time). This proves the fix: with Retention:2
// and 3+ incremental runs over an UNCHANGED source, the agent must NOT prune,
// and a verify/restore from the NEWEST manifest must still succeed.
//
// Before the fix (DeleteSnapshotContext reached in the incremental path) this
// test fails: the oldest prefix — holding the referenced object bytes — is
// deleted, and VerifyIntegrity of the newest snapshot reports failed objects.
func TestRunBackup_IncrementalRetentionDoesNotStrandReferencedObjects(t *testing.T) {
	tmpDir := t.TempDir()
	// A single unchanged file: every run after the first references its bytes
	// from the first snapshot's prefix.
	createTempFile(t, tmpDir, "data.txt", "unchanging content that is referenced forward")

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider:   provider,
		Paths:      []string{tmpDir},
		Retention:  2,
		StagingDir: t.TempDir(),
	})

	const runs = 4
	var lastSnapshotID string
	for i := 0; i < runs; i++ {
		job, err := mgr.RunBackupContext(context.Background(), nil)
		if err != nil {
			t.Fatalf("RunBackupContext #%d failed: %v", i+1, err)
		}
		if job.Status != jobStatusCompleted {
			t.Fatalf("run #%d status = %q, want %q", i+1, job.Status, jobStatusCompleted)
		}
		if job.Snapshot == nil {
			t.Fatalf("run #%d produced no snapshot", i+1)
		}
		lastSnapshotID = job.Snapshot.ID
		// Runs after the first must reference the earlier object, not re-upload.
		if i > 0 && job.ReferencedFiles == 0 {
			t.Fatalf("run #%d expected to reference the unchanged file, got ReferencedFiles=0", i+1)
		}
	}

	// All snapshots must be retained: reference-blind agent pruning is disabled
	// in the incremental path (only the server may prune).
	snapshots, err := ListSnapshots(provider)
	if err != nil {
		t.Fatalf("ListSnapshots failed: %v", err)
	}
	if len(snapshots) != runs {
		t.Fatalf("expected all %d snapshots retained (no agent-side prune in incremental path), got %d", runs, len(snapshots))
	}

	// The newest snapshot's referenced objects must all still exist: a verify
	// downloads every manifest entry's BackupPath (which for a reference entry
	// points into an OLDER prefix) and checks its checksum.
	result, err := VerifyIntegrity(provider, lastSnapshotID)
	if err != nil {
		t.Fatalf("VerifyIntegrity returned error: %v", err)
	}
	if result.Status != "passed" {
		t.Fatalf("newest snapshot must verify clean after retention runs, got status=%q failed=%v (referenced objects were pruned)",
			result.Status, result.FailedFiles)
	}
	if result.FilesVerified == 0 {
		t.Fatalf("expected the newest snapshot to verify at least one file, got 0")
	}
}

// failSubstringUploadProvider fails every upload whose localPath contains
// failSubstring (persistently — across the per-file retry too) and delegates
// everything else to the backing mock provider.
type failSubstringUploadProvider struct {
	*mockProvider
	failSubstring string
}

func (p *failSubstringUploadProvider) Upload(localPath, remotePath string) error {
	if strings.Contains(localPath, p.failSubstring) {
		return errors.New("simulated persistent upload failure")
	}
	return p.mockProvider.Upload(localPath, remotePath)
}

// A partial-success run (some files uploaded, some retry-exhausted) must
// complete WITH a visible Warning + ErrorCount — never as a green job with
// zero errors that is silently an incomplete restore point.
func TestRunBackupContext_PartialFailureSetsWarningAndErrorCount(t *testing.T) {
	restore := setUploadRetryDelayForTest(0)
	defer restore()

	dir := t.TempDir()
	createTempFile(t, dir, "good.txt", "good content")
	createTempFile(t, dir, "bad-file.txt", "doomed content")

	provider := &failSubstringUploadProvider{mockProvider: newMockProvider(), failSubstring: "bad-file"}
	mgr := NewBackupManager(BackupConfig{
		Provider:   provider,
		Paths:      []string{dir},
		StagingDir: t.TempDir(),
	})

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("partial success must not fail the run, got: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("expected completed status, got %q", job.Status)
	}
	if job.ErrorCount != 1 {
		t.Fatalf("expected ErrorCount=1, got %d", job.ErrorCount)
	}
	if !strings.Contains(job.Warning, "1 of 2 files failed to upload") {
		t.Fatalf("Warning must carry the failed/total counts, got: %q", job.Warning)
	}
	if !strings.Contains(job.Warning, "bad-file.txt") {
		t.Fatalf("Warning must name the failed file, got: %q", job.Warning)
	}
	if job.FilesBackedUp != 1 {
		t.Fatalf("expected 1 file backed up, got %d", job.FilesBackedUp)
	}
}

// A run that skips unreadable files during collection (permission-denied,
// walk failures, missing paths) must complete WITH a visible Warning +
// ErrorCount — never as a green job with errorCount 0. scan errors only ride
// job.Error otherwise, which marshals to `{}` and the server never reads.
func TestRunBackupContext_ScanErrorSetsWarningAndErrorCount(t *testing.T) {
	goodDir := t.TempDir()
	createTempFile(t, goodDir, "readable.txt", "content that uploads fine")
	// A second configured path that does not exist: os.Stat fails during
	// collection, producing a per-file scan error, while the good dir's file
	// still yields a completable snapshot.
	missingPath := pathpkg.Join(t.TempDir(), "does-not-exist")

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider:   provider,
		Paths:      []string{goodDir, missingPath},
		StagingDir: t.TempDir(),
	})

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("a partial-scan run must still complete, got: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("expected completed status, got %q", job.Status)
	}
	if job.ErrorCount != 1 {
		t.Fatalf("expected ErrorCount=1 for one unreadable path, got %d", job.ErrorCount)
	}
	if !strings.Contains(job.Warning, "could not be read during collection") {
		t.Fatalf("Warning must surface the collection failure, got: %q", job.Warning)
	}
	if !strings.Contains(job.Warning, "does-not-exist") {
		t.Fatalf("Warning must name the failed path, got: %q", job.Warning)
	}
	if job.FilesBackedUp != 1 {
		t.Fatalf("expected the readable file to still be backed up, got %d", job.FilesBackedUp)
	}
}

func TestSummarizeScanErrors(t *testing.T) {
	if got := summarizeScanErrors(nil); got != "" {
		t.Fatalf("no failures must summarize to empty, got %q", got)
	}

	var many []error
	for i := 0; i < 8; i++ {
		many = append(many, fmt.Errorf("scan boom %d", i))
	}
	got := summarizeScanErrors(many)
	if !strings.Contains(got, "8 file(s) could not be read during collection") {
		t.Fatalf("unexpected summary: %q", got)
	}
	if !strings.Contains(got, "(+3 more)") {
		t.Fatalf("expected overflow suffix for 8 failures with 5 details, got: %q", got)
	}
	if strings.Contains(got, "scan boom 5") {
		t.Fatalf("details must be capped at 5, got: %q", got)
	}
}

func TestFlattenJoinedErrors(t *testing.T) {
	if got := flattenJoinedErrors(nil); got != nil {
		t.Fatalf("nil error must flatten to nil, got %v", got)
	}
	single := errors.New("solo")
	if got := flattenJoinedErrors(single); len(got) != 1 {
		t.Fatalf("single error must flatten to 1, got %d", len(got))
	}
	joined := errors.Join(errors.New("a"), errors.New("b"), errors.Join(errors.New("c"), errors.New("d")))
	if got := flattenJoinedErrors(joined); len(got) != 4 {
		t.Fatalf("nested join must flatten to 4 leaves, got %d", len(got))
	}
}

func TestSummarizeUploadFailures(t *testing.T) {
	if got := summarizeUploadFailures(nil, 10); got != "" {
		t.Fatalf("no failures must summarize to empty, got %q", got)
	}

	two := []error{errors.New("first boom"), errors.New("second boom")}
	got := summarizeUploadFailures(two, 5)
	if !strings.Contains(got, "2 of 5 files failed to upload") ||
		!strings.Contains(got, "first boom") || !strings.Contains(got, "second boom") {
		t.Fatalf("unexpected summary: %q", got)
	}
	if strings.Contains(got, "more)") {
		t.Fatalf("no overflow suffix expected for 2 failures: %q", got)
	}

	var many []error
	for i := 0; i < 8; i++ {
		many = append(many, fmt.Errorf("boom %d", i))
	}
	got = summarizeUploadFailures(many, 20)
	if !strings.Contains(got, "8 of 20 files failed to upload") {
		t.Fatalf("unexpected summary: %q", got)
	}
	if !strings.Contains(got, "(+3 more)") {
		t.Fatalf("expected overflow suffix for 8 failures with 5 details, got: %q", got)
	}
	if strings.Contains(got, "boom 5") {
		t.Fatalf("details must be capped at 5, got: %q", got)
	}
}

// The whole-run keepalive must heartbeat during the pre-upload phases and then
// stop cleanly with no further emissions and no goroutine leak.
func TestStartRunKeepalive_EmitsThenStopsCleanly(t *testing.T) {
	restore := setProgressKeepaliveIntervalForTest(2 * time.Millisecond)
	defer restore()

	var mu sync.Mutex
	var calls int
	onProgress := func(filesDone, filesTotal int, bytesDone, bytesTotal int64) {
		mu.Lock()
		calls++
		mu.Unlock()
	}

	stop := startRunKeepalive(context.Background(), onProgress)

	// Wait for at least one heartbeat.
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		c := calls
		mu.Unlock()
		if c > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("keepalive never emitted a heartbeat")
		}
		time.Sleep(time.Millisecond)
	}

	stop()
	mu.Lock()
	afterStop := calls
	mu.Unlock()

	// No emissions may fire after stop returns (goroutine joined).
	time.Sleep(20 * time.Millisecond)
	mu.Lock()
	final := calls
	mu.Unlock()
	if final != afterStop {
		t.Fatalf("keepalive emitted after stop: %d -> %d (goroutine not joined)", afterStop, final)
	}

	// A second stop is a safe no-op (idempotent).
	stop()
}

// A nil callback yields a no-op stop func that never panics.
func TestStartRunKeepalive_NilCallbackNoOp(t *testing.T) {
	stop := startRunKeepalive(context.Background(), nil)
	stop()
	stop()
}

func TestResolveJournalDir_ExplicitStagingDirWins(t *testing.T) {
	dir, ok := resolveJournalDir("/opt/breeze/staging")
	if !ok || dir != "/opt/breeze/staging" {
		t.Fatalf("explicit staging dir must be used as-is, got (%q, %v)", dir, ok)
	}
}

func TestResolveJournalDir_FallsBackToHomeThenDataDir(t *testing.T) {
	restoreHome, restoreData := journalHomeDirFn, journalDataDirFn
	defer func() { journalHomeDirFn, journalDataDirFn = restoreHome, restoreData }()

	journalHomeDirFn = func() (string, error) { return "/home/breeze", nil }
	journalDataDirFn = func() string { return "/var/lib/breeze" }
	dir, ok := resolveJournalDir("")
	if !ok || dir != pathpkg.Join("/home/breeze", ".breeze", "backup-journal") {
		t.Fatalf("expected home-based journal dir, got (%q, %v)", dir, ok)
	}

	journalHomeDirFn = func() (string, error) { return "", errors.New("no home") }
	dir, ok = resolveJournalDir("")
	if !ok || dir != pathpkg.Join("/var/lib/breeze", "backup-journal") {
		t.Fatalf("expected data-dir journal dir, got (%q, %v)", dir, ok)
	}
}

// When neither an explicit staging dir, a home dir, nor a config data dir is
// available, journaling must be DISABLED — never fall back to the
// world-writable os.TempDir() (symlink/tamper surface for the root/SYSTEM
// helper).
func TestResolveJournalDir_TempDirOnlyDisablesJournaling(t *testing.T) {
	restoreHome, restoreData := journalHomeDirFn, journalDataDirFn
	defer func() { journalHomeDirFn, journalDataDirFn = restoreHome, restoreData }()
	journalHomeDirFn = func() (string, error) { return "", errors.New("no home") }
	journalDataDirFn = func() string { return "" }

	dir, ok := resolveJournalDir("")
	if ok || dir != "" {
		t.Fatalf("temp-dir-only environment must disable journaling, got (%q, %v)", dir, ok)
	}
}

// Manager-level: with no secure journal location the run must still complete
// (resume is an optimization) and must not create a journal file in the OS
// temp dir.
func TestRunBackupContext_NoSecureJournalDir_RunsWithoutJournal(t *testing.T) {
	restoreHome, restoreData := journalHomeDirFn, journalDataDirFn
	defer func() { journalHomeDirFn, journalDataDirFn = restoreHome, restoreData }()
	journalHomeDirFn = func() (string, error) { return "", errors.New("no home") }
	journalDataDirFn = func() string { return "" }

	dir := t.TempDir()
	createTempFile(t, dir, "a.txt", "content")

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{dir}})

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("journal-less run must still succeed: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("expected completed, got %q", job.Status)
	}

	journalPath := pathpkg.Join(os.TempDir(), journalFileName(backupIdentity(provider, []string{dir})))
	if _, statErr := os.Lstat(journalPath); !os.IsNotExist(statErr) {
		t.Fatalf("no journal file may be written to the world-writable temp dir, found %s (err=%v)", journalPath, statErr)
	}
}
