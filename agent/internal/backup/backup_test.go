package backup

import (
	"context"
	"errors"
	"fmt"
	"os"
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
