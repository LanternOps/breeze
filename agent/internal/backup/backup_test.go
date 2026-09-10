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

	"github.com/breeze-rmm/agent/internal/backup/layout"
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

// TestRunBackupContext_StaleJournalDiscardedWithoutRemoteCleanup proves the
// D18 §3.5 fix directly: a journal older than journalMaxAge is discarded
// and the run proceeds fresh with a brand new snapshot ID, but the STALE
// journal's remote prefix is left untouched — no agent-side delete, ever,
// for another run's (even an abandoned one's) prefix. GC's existing
// manifest-less-prefix rule is the only thing that may eventually reclaim
// it.
func TestRunBackupContext_StaleJournalDiscardedWithoutRemoteCleanup(t *testing.T) {
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

	orphanKey := path.Join(snapshotRootDir, staleSnapshotID, snapshotFilesDir, "orphan.gz")
	provider.files[orphanKey] = []byte("orphan")

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

	// The only legitimate delete is the NEW run's own upload.lease heartbeat
	// (Task 7), removed after its own successful publish — never anything
	// tied to the discarded stale journal's snapshot id.
	for _, key := range provider.deleteCalls {
		if !strings.HasSuffix(key, "/upload.lease") || strings.Contains(key, staleSnapshotID) {
			t.Fatalf("expected deletes to be limited to the new run's own upload.lease, got: %s (all: %v)", key, provider.deleteCalls)
		}
	}
	if _, stillThere := provider.files[orphanKey]; !stillThere {
		t.Fatal("the stale journal's orphan object must survive — the agent no longer cleans it up (GC's manifest-less rule is the backstop)")
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
	content := []byte("svc")
	if err := os.WriteFile(pathpkg.Join(stagingDir, "services.txt"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return &systemstate.SystemStateManifest{
			Platform: "test",
			Artifacts: []systemstate.Artifact{{
				Name: "services", Category: "services", Path: "services.txt",
				SizeBytes: int64(len(content)),
				// sha256("svc") — a real collector fills this in at collection
				// time (systemstate.artifactFromFile); this fixture stands in
				// for that.
				Checksum: "348c658682ae8701d3e9d21f191872491cf15e6acbb1681770b1cb787c1cf7ff",
			}},
		}, stagingDir, nil
	})

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{Provider: provider, SystemStateEnabled: true})
	job, err := mgr.RunBackup()
	if err != nil {
		t.Fatalf("system-state-only run should succeed with collected artifacts: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("status = %q, want completed", job.Status)
	}
	if job.Snapshot == nil {
		t.Fatal("a state-only success must still produce a snapshot")
	}
	wantArtifactKey := path.Join("snapshots", job.Snapshot.ID, "system-state", "services.txt")
	wantManifestKey := path.Join("snapshots", job.Snapshot.ID, "system-state", "manifest.json")
	wantOrdinaryManifestKey := path.Join("snapshots", job.Snapshot.ID, "manifest.json")
	if _, ok := provider.files[wantArtifactKey]; !ok {
		t.Errorf("expected artifact uploaded to %q, got keys %v", wantArtifactKey, providerKeys(provider))
	}
	if _, ok := provider.files[wantManifestKey]; !ok {
		t.Errorf("expected system-state manifest uploaded to %q, got keys %v", wantManifestKey, providerKeys(provider))
	}
	if _, ok := provider.files[wantOrdinaryManifestKey]; !ok {
		t.Errorf("expected ordinary (empty-files) manifest uploaded to %q, got keys %v", wantOrdinaryManifestKey, providerKeys(provider))
	}

	var ordinaryManifest Snapshot
	if err := json.Unmarshal(provider.files[wantOrdinaryManifestKey], &ordinaryManifest); err != nil {
		t.Fatalf("decode ordinary manifest: %v", err)
	}
	if len(ordinaryManifest.Files) != 0 {
		t.Errorf("ordinary manifest.files = %d, want 0 (state-only run)", len(ordinaryManifest.Files))
	}
	// len()==0 can't distinguish a nil slice ("files":null) from an empty one
	// ("files":[]) — the API's resultSchemas/queueSchemas reject null (they're
	// z.array(...).optional(), which accepts a missing key or [] but not
	// null) and silently drop the whole job result. Assert the raw wire shape,
	// not just the decoded length.
	var rawOrdinaryManifest map[string]json.RawMessage
	if err := json.Unmarshal(provider.files[wantOrdinaryManifestKey], &rawOrdinaryManifest); err != nil {
		t.Fatalf("decode ordinary manifest as raw JSON: %v", err)
	}
	if rawFiles := string(rawOrdinaryManifest["files"]); rawFiles != "[]" {
		t.Errorf(`ordinary manifest raw "files" = %s, want "[]" (not null) — API schemas reject null`, rawFiles)
	}
	if ordinaryManifest.ID != job.Snapshot.ID {
		t.Errorf("ordinary manifest ID = %q, want %q (must share the state prefix's snapshot ID)", ordinaryManifest.ID, job.Snapshot.ID)
	}

	var stateManifest systemstate.SystemStateManifest
	if err := json.Unmarshal(provider.files[wantManifestKey], &stateManifest); err != nil {
		t.Fatalf("decode system state manifest: %v", err)
	}
	if stateManifest.SchemaVersion != 1 {
		t.Errorf("system state manifest schemaVersion = %d, want 1", stateManifest.SchemaVersion)
	}
	if len(stateManifest.Artifacts) != 1 || stateManifest.Artifacts[0].Checksum == "" {
		t.Errorf("published system state manifest should carry the artifact's checksum, got %+v", stateManifest.Artifacts)
	}
}

func TestRunBackup_SystemState_MixedRunZeroWalkedFilesStillPublishesState(t *testing.T) {
	// A MIXED run (SystemStateEnabled AND configured file paths) whose walk
	// yields zero files — an empty directory, everything excluded, or a stale
	// configured path — must not lose already-collected system state. The
	// state-only special case used to be gated on len(m.config.Paths)==0, so
	// this exact shape (Paths configured, walk empty, state collected) fell
	// through to jobStatusSkipped, which removes the staging dir and
	// discards the state silently.
	emptyDir := t.TempDir()

	stagingDir := t.TempDir()
	content := []byte("svc")
	if err := os.WriteFile(pathpkg.Join(stagingDir, "services.txt"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return &systemstate.SystemStateManifest{
			Platform: "test",
			Artifacts: []systemstate.Artifact{{
				Name: "services", Category: "services", Path: "services.txt",
				SizeBytes: int64(len(content)),
				Checksum:  "348c658682ae8701d3e9d21f191872491cf15e6acbb1681770b1cb787c1cf7ff",
			}},
		}, stagingDir, nil
	})

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider:           provider,
		Paths:              []string{emptyDir},
		SystemStateEnabled: true,
	})
	job, err := mgr.RunBackup()
	if err != nil {
		t.Fatalf("mixed run with collected state should succeed despite an empty walk: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("status = %q, want %q", job.Status, jobStatusCompleted)
	}
	if job.Snapshot == nil {
		t.Fatal("collected state must still produce a snapshot even though the walk found nothing")
	}

	wantArtifactKey := path.Join("snapshots", job.Snapshot.ID, "system-state", "services.txt")
	wantManifestKey := path.Join("snapshots", job.Snapshot.ID, "system-state", "manifest.json")
	wantOrdinaryManifestKey := path.Join("snapshots", job.Snapshot.ID, "manifest.json")
	if _, ok := provider.files[wantArtifactKey]; !ok {
		t.Errorf("expected artifact uploaded to %q, got keys %v", wantArtifactKey, providerKeys(provider))
	}
	if _, ok := provider.files[wantManifestKey]; !ok {
		t.Errorf("expected system-state manifest uploaded to %q, got keys %v", wantManifestKey, providerKeys(provider))
	}
	if _, ok := provider.files[wantOrdinaryManifestKey]; !ok {
		t.Errorf("expected ordinary (empty-files) manifest uploaded to %q, got keys %v", wantOrdinaryManifestKey, providerKeys(provider))
	}
}

func TestRunBackup_SystemState_PublishOrderStateBeforeOrdinaryManifest(t *testing.T) {
	// A mixed run (ordinary files + system state) must publish the
	// system-state artifact(s), then the system-state manifest, and ONLY
	// THEN the ordinary manifest.json — the ordinary manifest is the "commit
	// point" a concurrent GC sweep uses to decide a snapshot-id group is
	// "manifest-bearing" (markLiveBackupObjects, backupRetention.ts). If the
	// ordinary manifest lands first, a GC sweep racing in between sees a
	// manifest-bearing group whose system-state/* objects aren't marked live
	// yet and can reap them under the per-object grace rule.
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "single.txt", "single file backup")

	stagingDir := t.TempDir()
	content := []byte("svc")
	if err := os.WriteFile(pathpkg.Join(stagingDir, "services.txt"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return &systemstate.SystemStateManifest{
			Platform: "test",
			Artifacts: []systemstate.Artifact{{
				Name: "services", Category: "services", Path: "services.txt",
				SizeBytes: int64(len(content)),
				Checksum:  "348c658682ae8701d3e9d21f191872491cf15e6acbb1681770b1cb787c1cf7ff",
			}},
		}, stagingDir, nil
	})

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider:           provider,
		Paths:              []string{file1},
		SystemStateEnabled: true,
	})
	job, err := mgr.RunBackup()
	if err != nil {
		t.Fatalf("RunBackup failed: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("status = %q, want %q", job.Status, jobStatusCompleted)
	}

	wantArtifactKey := path.Join("snapshots", job.Snapshot.ID, "system-state", "services.txt")
	wantStateManifestKey := path.Join("snapshots", job.Snapshot.ID, "system-state", "manifest.json")
	wantOrdinaryManifestKey := path.Join("snapshots", job.Snapshot.ID, "manifest.json")

	indexOf := func(remotePath string) int {
		for i, c := range provider.uploadCalls {
			if c.remotePath == remotePath {
				return i
			}
		}
		return -1
	}
	artifactIdx := indexOf(wantArtifactKey)
	stateManifestIdx := indexOf(wantStateManifestKey)
	ordinaryManifestIdx := indexOf(wantOrdinaryManifestKey)
	if artifactIdx == -1 || stateManifestIdx == -1 || ordinaryManifestIdx == -1 {
		t.Fatalf("missing expected upload(s): artifact=%d stateManifest=%d ordinaryManifest=%d, calls=%+v",
			artifactIdx, stateManifestIdx, ordinaryManifestIdx, provider.uploadCalls)
	}
	if artifactIdx >= stateManifestIdx || stateManifestIdx >= ordinaryManifestIdx {
		t.Errorf("wrong publish order: artifact=%d, stateManifest=%d, ordinaryManifest=%d (want artifact < stateManifest < ordinaryManifest)",
			artifactIdx, stateManifestIdx, ordinaryManifestIdx)
	}
}

// providerKeys returns the sorted list of remote keys the mock provider has
// stored, for readable test failure messages.
func providerKeys(p *mockProvider) []string {
	keys := make([]string, 0, len(p.files))
	for k := range p.files {
		keys = append(keys, k)
	}
	return keys
}

func TestRunBackup_SystemImage_CollectionFailureFailsLoud(t *testing.T) {
	// A system-state-only run whose collection fails entirely must fail loudly,
	// not fall through to a green empty snapshot (it has no file paths to fall
	// back on). The bug this guards: silently "protecting nothing".
	//
	// D11 (proven live on Windows Server 2022, helper 0.112.1): the collector
	// text must ride the returned error VERBATIM, and the run must never reach
	// createSnapshot/upload — asserted here via the fake provider's upload
	// call log, since a system-state-only run has no file paths to fall back
	// on and any upload would mean a snapshot was created from nothing.
	collectorErr := "system state collection missing required artifact(s) [registry] - image would not be restorable"
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return nil, "", fmt.Errorf("%s", collectorErr)
	})

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{Provider: provider, SystemStateEnabled: true})
	job, err := mgr.RunBackup()
	if err == nil {
		t.Fatal("expected failed collection to surface as an error")
	}
	if !strings.Contains(err.Error(), collectorErr) {
		t.Fatalf("collector error not carried verbatim: got %q, want it to contain %q", err.Error(), collectorErr)
	}
	if job == nil || job.Status != jobStatusFailed {
		t.Fatalf("status = %v, want %q", job, jobStatusFailed)
	}
	if job.Snapshot != nil {
		t.Fatalf("no snapshot should be created on a fail-loud system-state-only run, got %+v", job.Snapshot)
	}
	if len(provider.uploadCalls) != 0 {
		t.Fatalf("expected zero uploads (no createSnapshot call) on a fail-loud system-state-only run, got %d: %+v",
			len(provider.uploadCalls), provider.uploadCalls)
	}
}

// TestBackupJob_FailedRunJSON_OmitsNullSnapshot is the wire-shape half of D11.
// RunBackupContext already failed the job loudly (see
// TestRunBackup_SystemImage_CollectionFailureFailsLoud above) with job.Snapshot
// left nil, but marshaling that job with a bare `json:"snapshot"` tag emits an
// explicit `"snapshot":null` key. The API's backupCommandResultSchema models
// `snapshot` as `backupSnapshotResultSchema.optional()` (apps/api/src/routes/
// backup/resultSchemas.ts) — Zod's `.optional()` accepts a MISSING key but
// rejects an explicit `null`, so the whole result 400'd with "snapshot:
// Invalid input: expected object, received null" and the real failure reason
// (carried correctly in Stderr/job.Error, see the test above) never reached
// the job record. The key must be absent, not present-and-null, whenever no
// snapshot was created — on this failure path and on any other.
func TestBackupJob_FailedRunJSON_OmitsNullSnapshot(t *testing.T) {
	job := &BackupJob{
		ID:     "job-3",
		Status: jobStatusFailed,
		// Snapshot deliberately left nil — the exact shape RunBackupContext
		// returns for a fail-loud system-state-only run.
	}

	encoded, err := json.Marshal(job)
	if err != nil {
		t.Fatalf("marshal backup job: %v", err)
	}

	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("backup job must marshal to a JSON object: %v", err)
	}
	if _, present := decoded["snapshot"]; present {
		t.Fatalf(`a nil Snapshot must be OMITTED from the wire payload, not sent as null: %s`, encoded)
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
	content := []byte("svc")
	if err := os.WriteFile(pathpkg.Join(stagingDir, "services.txt"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return &systemstate.SystemStateManifest{
			Platform:        "test",
			Artifacts:       []systemstate.Artifact{{Name: "services", Category: "services", Path: "services.txt", SizeBytes: int64(len(content))}},
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

// TestRunBackup_MixedRun_SystemStatePublishFailureFailsLoud is the end-to-end
// guard for #3026/D15's symptom, at the level the bug actually presented: a
// run that ALSO has configured file paths, so the len(files)==0 hard-failure
// guard never fires on its own.
//
// The manifest claims two artifacts, but neither exists in the staging dir
// handed to publishSystemState (a stand-in for #3026's actual cause — a
// staging dir rewritten onto a shadow-device path that predated the
// snapshot — and any other way the collected bytes fail to reach the
// snapshot). That combination must NOT produce an unqualified `completed`:
// per the D15 contract, a job whose system state silently never reached the
// snapshot must fail loud, even though the ordinary file-path portion
// succeeded — this is the exact bug the old "warn and drop the artifact
// list" behavior papered over.
func TestRunBackup_MixedRun_SystemStatePublishFailureFailsLoud(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "doc.txt", "user data that backed up fine")

	// Collection reports artifacts, but nothing of theirs is on disk in the
	// staging dir handed back (a different, empty temp dir).
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return &systemstate.SystemStateManifest{
			Platform: "test",
			Artifacts: []systemstate.Artifact{
				{Name: "registry", Path: "registry.dat", SizeBytes: 4},
				{Name: "boot", Path: "boot.cfg", SizeBytes: 4},
			},
		}, t.TempDir(), nil
	})

	mgr := NewBackupManager(BackupConfig{
		Provider:           newMockProvider(),
		Paths:              []string{file1},
		SystemStateEnabled: true,
	})
	job, err := mgr.RunBackup()
	if err == nil {
		t.Fatal("a system state publish failure must fail the job, not complete green")
	}
	if job == nil || job.Status != jobStatusFailed {
		t.Fatalf("status = %v, want %q", job, jobStatusFailed)
	}
	if !strings.Contains(err.Error(), "system state publish failed") {
		t.Errorf("expected a clear 'system state publish failed' reason, got: %v", err)
	}
}

// A healthy run must not trip the detector — otherwise the warning fires on
// every system_image backup and operators learn to ignore it.
func TestRunBackup_SystemStateCapturedProducesNoWarning(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "doc.txt", "user data")

	stagingDir := t.TempDir()
	content := []byte("hive")
	if err := os.WriteFile(pathpkg.Join(stagingDir, "registry.dat"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return &systemstate.SystemStateManifest{
			Platform:  "test",
			Artifacts: []systemstate.Artifact{{Name: "registry", Path: "registry.dat", SizeBytes: int64(len(content))}},
		}, stagingDir, nil
	})

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider:           provider,
		Paths:              []string{file1},
		SystemStateEnabled: true,
	})
	job, err := mgr.RunBackup()
	if err != nil {
		t.Fatalf("RunBackup failed: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("status = %q, want completed", job.Status)
	}
	if job.Warning != "" {
		t.Errorf("healthy system-state run produced warning %q, want none", job.Warning)
	}
	if len(job.SystemStateManifest.Artifacts) != 1 {
		t.Errorf("a captured artifact list must be left intact, got %d", len(job.SystemStateManifest.Artifacts))
	}
	wantArtifactKey := path.Join("snapshots", job.Snapshot.ID, "system-state", "registry.dat")
	if _, ok := provider.files[wantArtifactKey]; !ok {
		t.Errorf("expected artifact uploaded to %q, got keys %v", wantArtifactKey, providerKeys(provider))
	}
}

// TestRunBackup_SystemStateCollectionFailureWarnsOnMixedRun covers the sibling
// route to the same silent outcome: collection fails outright on a run that has
// configured file paths. systemStateErr only fails the run when there is
// nothing else to fall back on, so without an explicit warning this completes
// green with no system state and no signal. CollectSystemState errors only when
// a REQUIRED class failed, i.e. the capture would not boot at restore time.
func TestRunBackup_SystemStateCollectionFailureWarnsOnMixedRun(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "doc.txt", "user data that backed up fine")

	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return nil, "", fmt.Errorf("registry hive export failed")
	})

	mgr := NewBackupManager(BackupConfig{
		Provider:           newMockProvider(),
		Paths:              []string{file1},
		SystemStateEnabled: true,
	})
	job, err := mgr.RunBackup()
	if err != nil {
		t.Fatalf("the file-path portion is still valid, so the run should complete: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("status = %q, want completed", job.Status)
	}
	if !strings.Contains(job.Warning, "system state was not collected") {
		t.Errorf("a failed collection on a mixed run must be surfaced; warning = %q", job.Warning)
	}
	if !strings.Contains(job.Warning, "registry hive export failed") {
		t.Errorf("the warning should carry the collector's reason; warning = %q", job.Warning)
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
// references back into it. Agent-side retention pruning of OTHER,
// already-published snapshots has been removed entirely (D18 §3.5,
// DeleteSnapshotContext deleted) — this test proves the server-only-
// retention invariant holds end-to-end: with Retention:2 (now fully
// ignored, see GetRetention's doc comment) and 3+ incremental runs over an
// UNCHANGED source, the agent must NOT prune, and a verify/restore from the
// NEWEST manifest must still succeed. (The narrower own-run-prefix cleanup
// in abortStopped/abortSourceGone is unaffected and unrelated to this test.)
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
		// AgentID is required for RunBackupContext's incremental dedupe to
		// find a previous run as its base (D6: previousManifest never
		// matches without a known identity — see runBackupIdentity).
		AgentID: "test-device",
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
//
// 1 of 2 files (and 54% of the bytes) is a DISPROPORTIONATE loss, so since
// #3000 the terminal status is `partial` rather than `completed`. Everything
// else this test guards — the run does not hard-fail, the snapshot is real,
// and the failures are visible in Warning/ErrorCount — is unchanged. See
// TestRunBackupContext_SmallFailureRatioStaysCompleted for the below-threshold
// counterpart that still reports `completed`.
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
	if job.Status != jobStatusPartial {
		t.Fatalf("expected partial status for a 1-of-2 failure run, got %q", job.Status)
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
//
// 1 unreadable path out of 2 attempted is disproportionate, so since #3000 the
// terminal status is `partial`. Note this case is caught by the FILE gate, not
// the byte gate: a file whose os.Stat failed has no known size and contributes
// nothing to the scanned-byte denominator.
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
	if job.Status != jobStatusPartial {
		t.Fatalf("expected partial status for a 1-of-2 unreadable-path run, got %q", job.Status)
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
	var sawSnapshotID bool
	onProgress := func(filesDone, filesTotal int, bytesDone, bytesTotal int64, snapshotID string) {
		mu.Lock()
		calls++
		if snapshotID != "" {
			sawSnapshotID = true
		}
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

	// The pre-scan keepalive runs before any snapshot exists, so it must never
	// claim one (#3006): a non-empty ID here would let the server record a
	// snapshot_id for objects that were never written.
	mu.Lock()
	claimed := sawSnapshotID
	mu.Unlock()
	if claimed {
		t.Fatal("pre-scan keepalive emitted a non-empty snapshot ID")
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

// listRecordingProvider wraps mockProvider and counts List calls, proving
// goal 4 ("the agent never lists the bucket to choose a base") at the
// RunBackupContext level — fetchServerOwnedBase's own unit tests (Task 2)
// only prove it in isolation.
type listRecordingProvider struct {
	*mockProvider
	listCalls int
}

func (p *listRecordingProvider) List(prefix string) ([]string, error) {
	p.listCalls++
	return p.mockProvider.List(prefix)
}

func TestRunBackupContext_ServerOwnedMode_NeverListsTheBucket(t *testing.T) {
	tmpDir := t.TempDir()
	createTempFile(t, tmpDir, "file1.txt", "content")
	backing := newMockProvider()
	provider := &listRecordingProvider{mockProvider: backing}

	baseID := "snap-base"
	mgr := NewBackupManager(BackupConfig{
		Provider:       provider,
		Paths:          []string{tmpDir},
		StagingDir:     t.TempDir(),
		AgentID:        "test-device",
		BaseSnapshotID: &baseID,
		// Well beyond publishMargin (1h) so this test doesn't flake on the
		// margin boundary — it's proving "never lists the bucket", not the
		// lease-expiry edge (that's TestLeaseGate_RefusesManifestPastLeaseMargin).
		PublishLeaseExpiresAt: time.Now().Add(4 * time.Hour),
	})

	// Seed the server-selected base AFTER constructing mgr, using its own
	// runBackupIdentity() so the identity guard (D6) matches exactly what
	// this run will compute — see incremental.go's fetchServerOwnedBase.
	base := &Snapshot{
		ID:             baseID,
		BackupIdentity: mgr.runBackupIdentity(),
		Files:          []SnapshotFile{{SourcePath: "/prior.txt", BackupPath: "snapshots/snap-base/files/prior.txt.gz", Size: 3}},
	}
	storeManifest(t, backing, base)

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext failed: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("job.Status = %q, want %q", job.Status, jobStatusCompleted)
	}
	if provider.listCalls != 0 {
		t.Fatalf("expected zero List calls in server-owned mode, got %d", provider.listCalls)
	}
}

func TestRunBackupContext_ExpiredLease_RefusesToPublishManifest(t *testing.T) {
	tmpDir := t.TempDir()
	createTempFile(t, tmpDir, "file1.txt", "content")
	provider := newMockProvider()

	baseID := "" // full run — the lease is enforced for full runs too, not just incremental ones
	mgr := NewBackupManager(BackupConfig{
		Provider:              provider,
		Paths:                 []string{tmpDir},
		StagingDir:            t.TempDir(),
		AgentID:               "test-device",
		BaseSnapshotID:        &baseID,
		PublishLeaseExpiresAt: time.Now().Add(-1 * time.Hour), // already expired
	})

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if !errors.Is(err, ErrPublishLeaseExpired) {
		t.Fatalf("err = %v, want ErrPublishLeaseExpired", err)
	}
	if job.Status != jobStatusFailed {
		t.Fatalf("job.Status = %q, want %q", job.Status, jobStatusFailed)
	}
	for key := range provider.files {
		if isManifestPath(key) {
			t.Fatalf("manifest was published despite an expired lease: %s", key)
		}
	}
}

// D18 §3.5: agent-side retention pruning is removed entirely. A
// system-state-only run is the ONLY config shape that reaches the (now
// removed) retention-prune branch pre-fix — incrementalDedupeActive is
// false exactly when SystemStateEnabled && len(Paths)==0 (backup.go's
// dedupe-active check) — so this is the config that actually exercises the
// danger, unlike a Paths-configured run which never reaches that branch
// either way.
func TestBackupNeverDeletesRemoteObjects_RetentionConfigured(t *testing.T) {
	// A fresh staging dir per invocation, not one shared across all 3 runs:
	// RunBackupContext os.RemoveAll's the system-state staging dir it's
	// handed at the end of every successful run (backup.go), so reusing one
	// fixed path across iterations would make run #2 fail to stat it — a
	// real collision with production cleanup behavior, not this test's
	// concern (see the plan's Task 5 note that this bug was a plan defect).
	svcContent := []byte("svc")
	newStagingDir := func() string {
		dir := t.TempDir()
		if err := os.WriteFile(pathpkg.Join(dir, "services.txt"), svcContent, 0o600); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		// D15 Wave 1: system state now publishes only what the manifest's
		// Artifacts describe (publishSystemState), not whatever the file
		// walk happened to see — a manifest with zero artifacts is a hard
		// failure (RunBackupContext's "system state collection produced no
		// artifacts" branch), so this fixture must declare the staged file
		// as an artifact, matching TestRunBackup_SystemImage_NoPathsAllowed's
		// pattern above.
		return &systemstate.SystemStateManifest{
			Platform: "test",
			Artifacts: []systemstate.Artifact{{
				Name: "services", Category: "services", Path: "services.txt",
				SizeBytes: int64(len(svcContent)),
			}},
		}, newStagingDir(), nil
	})

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider:           provider,
		SystemStateEnabled: true,
		Retention:          1, // ignored — see GetRetention's doc comment
		StagingDir:         t.TempDir(),
		AgentID:            "test-device",
	})

	for i := 0; i < 3; i++ {
		if _, err := mgr.RunBackupContext(context.Background(), nil); err != nil {
			t.Fatalf("RunBackupContext #%d failed: %v", i+1, err)
		}
	}
	// After Task 7, each run's own upload.lease is written then deleted —
	// the ONLY delete this test may legitimately see. Any delete for a
	// DIFFERENT run's snapshot id (i.e. anything but that run's own
	// upload.lease) is the retention-prune bug this test guards against.
	for _, key := range provider.deleteCalls {
		if !strings.HasSuffix(key, "/upload.lease") {
			t.Fatalf("expected deletes to be limited to each run's own upload.lease, got: %s (all: %v)", key, provider.deleteCalls)
		}
	}
}

// TestRunBackupContext_StateOnlyZeroFiles_ExpiredLease_RefusesToPublish
// proves the D15-merge fix: D15 Wave 1's state-only-zero-walked-files
// publish path (backup.go, "backup run finished with state artifacts but
// zero walked files") writes snapshots/<id>/system-state/manifest.json and
// snapshots/<id>/manifest.json directly, OUTSIDE createSnapshotWithProgress
// — it must still go through the SAME leaseGate-wrapped provider as every
// other publish path (D18 §3.1), not the raw m.config.Provider. Before the
// fix (uploadProvider built after this branch instead of before it), this
// exact scenario would silently publish past an already-expired lease.
func TestRunBackupContext_StateOnlyZeroFiles_ExpiredLease_RefusesToPublish(t *testing.T) {
	svcContent := []byte("svc")
	stagingDir := t.TempDir()
	if err := os.WriteFile(pathpkg.Join(stagingDir, "services.txt"), svcContent, 0o600); err != nil {
		t.Fatal(err)
	}
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return &systemstate.SystemStateManifest{
			Platform: "test",
			Artifacts: []systemstate.Artifact{{
				Name: "services", Category: "services", Path: "services.txt",
				SizeBytes: int64(len(svcContent)),
			}},
		}, stagingDir, nil
	})

	provider := newMockProvider()
	baseID := "" // full run — the lease fences state-only publishes too, not just ordinary ones
	mgr := NewBackupManager(BackupConfig{
		Provider:              provider,
		SystemStateEnabled:    true,
		StagingDir:            t.TempDir(),
		AgentID:               "test-device",
		BaseSnapshotID:        &baseID,
		PublishLeaseExpiresAt: time.Now().Add(-1 * time.Hour), // already expired
	})

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if !errors.Is(err, ErrPublishLeaseExpired) {
		t.Fatalf("err = %v, want ErrPublishLeaseExpired", err)
	}
	if job.Status != jobStatusFailed {
		t.Fatalf("job.Status = %q, want %q", job.Status, jobStatusFailed)
	}
	for key := range provider.files {
		if isManifestPath(key) {
			t.Fatalf("a manifest was published (state-only zero-files path) despite an expired lease: %s", key)
		}
	}
}

// TestRunBackupContext_ResumeWithPublishedManifest_SucceedsEvenIfSourceGone
// proves the P2 ordering fix: the resume-with-already-published-manifest
// check must run BEFORE any source scanning, so a resumed run whose
// manifest was already published reports success even if the configured
// source has since vanished.
func TestRunBackupContext_ResumeWithPublishedManifest_SucceedsEvenIfSourceGone(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "file1.txt", "content")
	provider := newMockProvider()
	stagingDir := t.TempDir()

	identity := backupIdentity(provider, []string{tmpDir})
	journal, _, err := openSnapshotJournal(stagingDir, identity, journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	published := &Snapshot{
		ID:    journal.snapshotID,
		Files: []SnapshotFile{{SourcePath: file1, BackupPath: "snapshots/" + journal.snapshotID + "/files/file1.txt.gz", Size: 7}},
		Size:  7,
	}
	storeManifest(t, provider, published)
	journal.Abandon()

	// The source is now GONE — remove the file (and its directory) the
	// configured path pointed at, so a fresh scan would find nothing and,
	// pre-fix, hit backup.go's len(files)==0 early exit BEFORE the
	// journal/resume check ever ran.
	if err := os.RemoveAll(tmpDir); err != nil {
		t.Fatalf("failed to remove source dir: %v", err)
	}

	mgr := NewBackupManager(BackupConfig{
		Provider:   provider,
		Paths:      []string{tmpDir},
		StagingDir: stagingDir,
	})

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("expected the resume shortcut to succeed despite the gone source, got err: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("job.Status = %q, want %q (source-gone must not prevent reporting the already-published manifest)", job.Status, jobStatusCompleted)
	}
	if job.Snapshot == nil || job.Snapshot.ID != journal.snapshotID {
		t.Fatalf("expected the already-published snapshot back, got %+v", job.Snapshot)
	}
}

func stubCollectLayout(t *testing.T, fn func(context.Context) (*layout.Manifest, error)) {
	t.Helper()
	orig := collectLayout
	t.Cleanup(func() { collectLayout = orig })
	collectLayout = fn
}

func restorableLayout() *layout.Manifest {
	return &layout.Manifest{
		SchemaVersion: layout.SchemaVersion, Platform: "linux", BootMode: layout.BootModeUEFI,
		Disks: []layout.Disk{{Name: "/dev/sda", TableType: "gpt", SizeBytes: 64 << 30, IsSystem: true, Partitions: []layout.Partition{
			{Number: 1, Name: "/dev/sda1", TypeGUID: layout.GUIDEFISystem, Filesystem: "vfat", MountPoint: "/boot/efi", Role: layout.RoleEFI, Encryption: layout.EncryptionNone},
			{Number: 2, Name: "/dev/sda2", Filesystem: "ext4", MountPoint: "/", Role: layout.RoleRoot, Encryption: layout.EncryptionNone},
		}}},
	}
}

func TestRunBackup_Layout_PublishedBeforeOrdinaryManifestAndCarriedOnJob(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "single.txt", "single file backup")
	stagingDir := t.TempDir()
	if err := os.WriteFile(pathpkg.Join(stagingDir, "services.txt"), []byte("svc"), 0o600); err != nil {
		t.Fatal(err)
	}
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return &systemstate.SystemStateManifest{Platform: "test", Artifacts: []systemstate.Artifact{{Name: "services", Category: "services", Path: "services.txt", SizeBytes: 3, Checksum: "348c658682ae8701d3e9d21f191872491cf15e6acbb1681770b1cb787c1cf7ff"}}}, stagingDir, nil
	})
	stubCollectLayout(t, func(context.Context) (*layout.Manifest, error) { return restorableLayout(), nil })

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{file1}, SystemStateEnabled: true})
	job, err := mgr.RunBackup()
	if err != nil {
		t.Fatalf("RunBackup failed: %v", err)
	}
	if job.LayoutManifest == nil || job.BareMetal == nil || !job.BareMetal.Restorable {
		t.Fatalf("job layout=%v bareMetal=%+v", job.LayoutManifest != nil, job.BareMetal)
	}
	if job.Warning != "" {
		t.Errorf("unexpected warning %q", job.Warning)
	}
	layoutKey := path.Join("snapshots", job.Snapshot.ID, "layout.json")
	stateKey := path.Join("snapshots", job.Snapshot.ID, "system-state", "manifest.json")
	ordinaryKey := path.Join("snapshots", job.Snapshot.ID, "manifest.json")
	idx := func(k string) int {
		for i, c := range provider.uploadCalls {
			if c.remotePath == k {
				return i
			}
		}
		return -1
	}
	li, si, oi := idx(layoutKey), idx(stateKey), idx(ordinaryKey)
	if li == -1 || si == -1 || oi == -1 || !(si < li && li < oi) {
		t.Fatalf("publish order state=%d layout=%d ordinary=%d (want state < layout < ordinary); keys=%v", si, li, oi, providerKeys(provider))
	}
	var stored layout.Manifest
	if err := json.Unmarshal(provider.files[layoutKey], &stored); err != nil || stored.SchemaVersion != layout.SchemaVersion || len(stored.Disks) != 1 {
		t.Fatalf("stored layout.json = %s err=%v", provider.files[layoutKey], err)
	}
	// The result JSON the helper ships to the server carries both fields.
	data, _ := json.Marshal(job)
	var wire map[string]json.RawMessage
	_ = json.Unmarshal(data, &wire)
	if _, ok := wire["layoutManifest"]; !ok {
		t.Error("layoutManifest missing from job JSON")
	}
	if _, ok := wire["bareMetal"]; !ok {
		t.Error("bareMetal missing from job JSON")
	}
}

func TestRunBackup_Layout_NotRestorableAppendsWarning(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "a.txt", "x")
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return &systemstate.SystemStateManifest{Platform: "test"}, t.TempDir(), nil
	})
	stubCollectLayout(t, func(context.Context) (*layout.Manifest, error) {
		m := restorableLayout()
		m.BootMode = layout.BootModeBIOS
		return m, nil
	})
	provider := newMockProvider()
	job, err := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{file1}, SystemStateEnabled: true}).RunBackup()
	if err != nil {
		t.Fatal(err)
	}
	if job.BareMetal == nil || job.BareMetal.Restorable || job.BareMetal.Reasons[0] != layout.ReasonBIOSBoot {
		t.Fatalf("bareMetal = %+v", job.BareMetal)
	}
	if !strings.Contains(job.Warning, "not bare-metal restorable: "+layout.ReasonBIOSBoot) {
		t.Errorf("warning = %q", job.Warning)
	}
	if job.Status != jobStatusCompleted {
		t.Errorf("status = %q", job.Status)
	}
}

func TestRunBackup_Layout_CollectFailureIsWarningNotFailure(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "a.txt", "x")
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return &systemstate.SystemStateManifest{Platform: "test"}, t.TempDir(), nil
	})
	stubCollectLayout(t, func(context.Context) (*layout.Manifest, error) { return nil, errors.New("lsblk: exit 1") })
	provider := newMockProvider()
	job, err := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{file1}, SystemStateEnabled: true}).RunBackup()
	if err != nil {
		t.Fatal(err)
	}
	if job.LayoutManifest != nil || job.BareMetal == nil || job.BareMetal.Restorable || !strings.Contains(job.BareMetal.Reasons[0], "lsblk: exit 1") {
		t.Fatalf("job layout=%v bareMetal=%+v", job.LayoutManifest, job.BareMetal)
	}
	if !strings.Contains(job.Warning, "disk layout was not captured: lsblk: exit 1") {
		t.Errorf("warning = %q", job.Warning)
	}
	for _, c := range provider.uploadCalls {
		if strings.HasSuffix(c.remotePath, "/layout.json") {
			t.Fatalf("layout.json must not be uploaded when collection failed: %v", providerKeys(provider))
		}
	}
}

func TestRunBackup_FileOnlyRunNeverCollectsLayout(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "a.txt", "x")
	called := false
	stubCollectLayout(t, func(context.Context) (*layout.Manifest, error) { called = true; return restorableLayout(), nil })
	provider := newMockProvider()
	job, err := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{file1}}).RunBackup()
	if err != nil {
		t.Fatal(err)
	}
	if called || job.LayoutManifest != nil || job.BareMetal != nil {
		t.Fatalf("file-only run touched layout: called=%v job=%+v", called, job)
	}
}
