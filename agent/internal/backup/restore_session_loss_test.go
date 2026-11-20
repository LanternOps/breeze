package backup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// A brokered read session the server revoked answers every later request
// with providers.ErrStorageSessionUnavailable. A file restore used to treat
// that as a per-file failure and walk the rest of the manifest, failing every
// remaining file with one WARN line each. These tests pin the restore ending
// at the first session-lost answer instead: the files already written stay
// (and are reported), the rest are not attempted, and a later run resumes.

const restorePerFileWarn = "restored file failed its download or content check"

func sessionLossRestoreConfig(t *testing.T, snapshotID string) RestoreConfig {
	t.Helper()
	return RestoreConfig{SnapshotID: snapshotID, TargetPath: t.TempDir(), WorkRoot: t.TempDir()}
}

func TestRestore_SessionLostMidRunStopsEarly(t *testing.T) {
	defer setRestoreConcurrencyForTest(1)()
	logged := captureBackupLogs(t)
	const n = 50
	p := newScriptedDownloadProvider(t, "restore-session-lost", n)
	p.objectErr = sessionGoneFrom(3)
	cfg := sessionLossRestoreConfig(t, "restore-session-lost")

	var result *RestoreResult
	var err error
	runWithWatchdog(t, 10*time.Second, func() {
		result, err = RestoreFromSnapshotContext(context.Background(), p, cfg, nil)
	})
	if err != nil {
		t.Fatalf("a lost session must not be an error (it discards the counts), got %v", err)
	}
	if got := p.startedObjects(); got != 4 {
		t.Fatalf("started %d downloads, want 4 (the run ends at the first session-lost answer)", got)
	}
	if result.FilesRestored != 3 || result.FilesFailed != 0 || len(result.FailedFiles) != 0 {
		t.Fatalf("restored=%d failed=%d failedFiles=%v, want 3/0/none (a lost session is not a file failure)",
			result.FilesRestored, result.FilesFailed, result.FailedFiles)
	}
	if result.FilesNotAttempted != n-3 {
		t.Fatalf("filesNotAttempted = %d, want %d", result.FilesNotAttempted, n-3)
	}
	if result.Status != "partial" || result.Code != ResultCodeStorageSessionLost {
		t.Fatalf("status=%q code=%q, want partial/%s", result.Status, result.Code, ResultCodeStorageSessionLost)
	}
	for _, want := range []string{"restore stopped", "storage session ended", "after 3 of 50 files", "3 restored, 0 failed", "remaining 47 were not attempted", "session deadline has passed"} {
		if !strings.Contains(result.Error, want) {
			t.Fatalf("error = %q, want it to contain %q", result.Error, want)
		}
	}
	if strings.Contains(result.Error, "cancelled") {
		t.Fatalf("error = %q calls a lost session a cancel", result.Error)
	}
	// What was written stays written: a restore is never rolled back.
	for i := range 3 {
		if _, statErr := os.Stat(filepath.Join(cfg.TargetPath, "data", fmt.Sprintf("f%03d.txt", i))); statErr != nil {
			t.Fatalf("restored file %d is gone: %v", i, statErr)
		}
	}
	if result.StagingDir == "" {
		t.Fatal("staging dir was cleaned up; the resume state of an unfinished restore must be kept")
	}
	if got := warnLines(logged.String(), restorePerFileWarn); got != 0 {
		t.Fatalf("logged %d per-file WARN lines for a lost session, want 0:\n%s", got, logged.String())
	}
	if got := warnLines(logged.String(), "storage session ended"); got != 1 {
		t.Fatalf("logged %d abort WARN lines, want exactly 1:\n%s", got, logged.String())
	}
}

func TestRestore_SessionLostBeforeAnythingRestoredIsFailed(t *testing.T) {
	defer setRestoreConcurrencyForTest(1)()
	p := newScriptedDownloadProvider(t, "restore-session-lost-zero", 20)
	p.objectErr = sessionGoneFrom(0)

	result, err := RestoreFromSnapshotContext(context.Background(), p, sessionLossRestoreConfig(t, "restore-session-lost-zero"), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := p.startedObjects(); got != 1 {
		t.Fatalf("started %d downloads, want 1", got)
	}
	if result.Status != "failed" || result.Code != ResultCodeStorageSessionLost {
		t.Fatalf("status=%q code=%q, want failed/%s", result.Status, result.Code, ResultCodeStorageSessionLost)
	}
	if result.FilesRestored != 0 || result.FilesFailed != 0 || result.FilesNotAttempted != 20 {
		t.Fatalf("restored=%d failed=%d notAttempted=%d, want 0/0/20", result.FilesRestored, result.FilesFailed, result.FilesNotAttempted)
	}
}

// With the real concurrency, the downloads already in flight when the
// session ends come back session-lost too. None of them may be counted as a
// failed file or logged one WARN each.
func TestRestore_SessionLostAtDefaultConcurrencyFailsNoFile(t *testing.T) {
	logged := captureBackupLogs(t)
	const n = 200
	p := newScriptedDownloadProvider(t, "restore-session-lost-concurrent", n)
	p.objectErr = sessionGoneFrom(10)

	var result *RestoreResult
	var err error
	runWithWatchdog(t, 10*time.Second, func() {
		result, err = RestoreFromSnapshotContext(context.Background(), p, sessionLossRestoreConfig(t, "restore-session-lost-concurrent"), nil)
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.FilesFailed != 0 || len(result.FailedFiles) != 0 {
		t.Fatalf("failed=%d failedFiles=%v, want none", result.FilesFailed, result.FailedFiles)
	}
	if result.FilesRestored+result.FilesNotAttempted != n || result.FilesNotAttempted < n-10 {
		t.Fatalf("restored=%d notAttempted=%d, want every one of %d files accounted for, at least %d not attempted",
			result.FilesRestored, result.FilesNotAttempted, n, n-10)
	}
	if result.Code != ResultCodeStorageSessionLost {
		t.Fatalf("code = %q, want %q", result.Code, ResultCodeStorageSessionLost)
	}
	if got := p.startedObjects(); got > 10+restoreDownloadConcurrency*restoreWindowPerWorker {
		t.Fatalf("started %d downloads after the session ended at file 10; want the run to stop", got)
	}
	if got := warnLines(logged.String(), restorePerFileWarn); got != 0 {
		t.Fatalf("logged %d per-file WARN lines for a lost session, want 0:\n%s", got, logged.String())
	}
}

// A later run of the same restore picks up where the lost session left it.
func TestRestore_SessionLostRunResumes(t *testing.T) {
	defer setRestoreConcurrencyForTest(1)()
	const n = 12
	p := newScriptedDownloadProvider(t, "restore-session-lost-resume", n)
	p.objectErr = sessionGoneFrom(5)
	cfg := sessionLossRestoreConfig(t, "restore-session-lost-resume")

	first, err := RestoreFromSnapshotContext(context.Background(), p, cfg, nil)
	if err != nil || first.Code != ResultCodeStorageSessionLost || first.FilesRestored != 5 {
		t.Fatalf("first run = %+v, %v; want 5 restored and a lost session", first, err)
	}

	p2 := newScriptedDownloadProvider(t, "restore-session-lost-resume", n)
	second, err := RestoreFromSnapshotContext(context.Background(), p2, cfg, nil)
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	if second.Status != "completed" || second.FilesRestored != n || second.FilesNotAttempted != 0 || second.Code != "" {
		t.Fatalf("second run = %+v, want completed with all %d files", second, n)
	}
	if got := p2.startedObjects(); got != n-5 {
		t.Fatalf("second run downloaded %d files, want %d (the first run's files resume)", got, n-5)
	}
}

func TestRestore_SessionLostDuringManifestDownload(t *testing.T) {
	p := newScriptedDownloadProvider(t, "restore-session-lost-manifest", 5)
	p.manifestErr = errTestSessionGone

	result, err := RestoreFromSnapshotContext(context.Background(), p, sessionLossRestoreConfig(t, "restore-session-lost-manifest"), nil)
	if err != nil {
		t.Fatalf("a lost session must come back as a result body, got error %v", err)
	}
	if result.Status != "failed" || result.Code != ResultCodeStorageSessionLost {
		t.Fatalf("status=%q code=%q, want failed/%s", result.Status, result.Code, ResultCodeStorageSessionLost)
	}
	if !strings.Contains(result.Error, "storage session ended") || !strings.Contains(result.Error, "manifest") {
		t.Fatalf("error = %q, want a session-ended reason naming the manifest", result.Error)
	}
	if got := p.startedObjects(); got != 0 {
		t.Fatalf("started %d object downloads, want 0", got)
	}
}

// A caller stop also closes the session, so the in-flight read answers
// session-lost; the run must still be reported as cancelled.
func TestRestore_CallerCancelIsNotASessionLoss(t *testing.T) {
	defer setRestoreConcurrencyForTest(1)()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := newScriptedDownloadProvider(t, "restore-cancel", 20)
	gone := sessionGoneFrom(3)
	p.objectErr = func(c context.Context, remotePath string) error {
		if err := gone(c, remotePath); err != nil {
			cancel()
			return err
		}
		return nil
	}

	result, err := RestoreFromSnapshotContext(ctx, p, sessionLossRestoreConfig(t, "restore-cancel"), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Code == ResultCodeStorageSessionLost {
		t.Fatalf("a caller cancel was reported as a lost session: %+v", result)
	}
	if !strings.Contains(result.Error, "operation cancelled") || result.Status != "partial" {
		t.Fatalf("status=%q error=%q, want partial / operation cancelled", result.Status, result.Error)
	}
	if result.FilesFailed != 0 {
		t.Fatalf("failed = %d, want 0 (the interrupted file has no verdict)", result.FilesFailed)
	}
}

// Ordinary per-file errors, and a refused-destination answer (which only a
// brokered WRITER uses), still fail one file and the run goes on.
func TestRestore_OrdinaryFileErrorsDoNotEndTheRun(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"plain error", errors.New("connection reset by peer")},
		{"destination refused", fmt.Errorf("%w: 403", providers.ErrDestinationRefused)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer setRestoreConcurrencyForTest(1)()
			const n = 10
			p := newScriptedDownloadProvider(t, "restore-file-error", n)
			p.objectErr = func(_ context.Context, remotePath string) error {
				if strings.HasSuffix(remotePath, "f002.txt") {
					return tc.err
				}
				return nil
			}
			result, err := RestoreFromSnapshotContext(context.Background(), p, sessionLossRestoreConfig(t, "restore-file-error"), nil)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if result.FilesRestored != n-1 || result.FilesFailed != 1 || result.FilesNotAttempted != 0 {
				t.Fatalf("restored=%d failed=%d notAttempted=%d, want %d/1/0", result.FilesRestored, result.FilesFailed, result.FilesNotAttempted, n-1)
			}
			if result.Status != "partial" || result.Code != "" {
				t.Fatalf("status=%q code=%q, want partial with no code", result.Status, result.Code)
			}
		})
	}
}
