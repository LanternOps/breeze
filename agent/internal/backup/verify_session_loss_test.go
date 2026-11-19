package backup

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/logging"
)

// A brokered read session the server revoked answers every later request
// with providers.ErrStorageSessionUnavailable. Verification used to treat that
// as a per-file failure and walk the rest of the manifest: 484,767 "failed"
// files and one WARN each, for a backup that was fine. These tests pin the
// run ending at the first session-lost answer instead.

const sessionLostCode = "storage_session_lost"

// sessionGoneFrom answers errTestSessionGone for every object at manifest
// index >= from (the scripted provider names objects f000.txt, f001.txt, …).
func sessionGoneFrom(snapshotID string, from int) func(context.Context, string) error {
	return func(_ context.Context, remotePath string) error {
		var i int
		base := path.Base(remotePath)
		if _, err := fmt.Sscanf(base, "f%03d.txt", &i); err != nil {
			return fmt.Errorf("test setup: unexpected key %q", remotePath)
		}
		if i >= from {
			return errTestSessionGone
		}
		return nil
	}
}

// captureBackupLogs routes the package logger (the logging package's root
// handler) into a buffer for the test's duration. Tests that call it must not
// run in parallel.
func captureBackupLogs(t *testing.T) *lockedBuffer {
	t.Helper()
	buf := &lockedBuffer{}
	logging.Init("text", "debug", buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })
	return buf
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// warnLines returns the WARN-level lines containing substr.
func warnLines(logged, substr string) int {
	n := 0
	for _, line := range strings.Split(logged, "\n") {
		if strings.Contains(line, "level=WARN") && strings.Contains(line, substr) {
			n++
		}
	}
	return n
}

func TestVerifyIntegrity_SessionLostMidRunStopsEarly(t *testing.T) {
	defer setVerifyConcurrencyForTest(1)()
	defer setDownloadTimeoutFloorForTest(time.Hour)()
	logged := captureBackupLogs(t)
	const n = 50
	p := newScriptedDownloadProvider(t, "verify-session-lost", n)
	p.objectErr = sessionGoneFrom("verify-session-lost", 3)

	var result *VerifyResult
	var err error
	runWithWatchdog(t, 10*time.Second, func() {
		result, err = VerifyIntegrityWithOptions(context.Background(), p, "verify-session-lost",
			VerifyOptions{TimeBudget: time.Hour})
	})
	if err != nil {
		t.Fatalf("a lost session must not be an error (it discards the counts), got %v", err)
	}
	if got := p.startedObjects(); got != 4 {
		t.Fatalf("started %d downloads, want 4 (the run ends at the first session-lost answer)", got)
	}
	if result.FilesVerified != 3 || result.FilesFailed != 0 || len(result.FailedFiles) != 0 {
		t.Fatalf("verified=%d failed=%d failedFiles=%v, want 3/0/none (a lost session is not a file failure)",
			result.FilesVerified, result.FilesFailed, result.FailedFiles)
	}
	if result.FilesUnchecked != n-3 {
		t.Fatalf("filesUnchecked = %d, want %d", result.FilesUnchecked, n-3)
	}
	if result.Status != "partial" || result.Code != sessionLostCode {
		t.Fatalf("status=%q code=%q, want partial/%s", result.Status, result.Code, sessionLostCode)
	}
	for _, want := range []string{"storage session ended", "checked 3 of 50 files (3 ok, 0 failed)", "remaining 47 were not verified", "session deadline has passed"} {
		if !strings.Contains(result.Error, want) {
			t.Fatalf("error = %q, want it to contain %q", result.Error, want)
		}
	}
	if strings.Contains(result.Error, "time budget") {
		t.Fatalf("error = %q names the time budget for a lost session", result.Error)
	}
	if got := warnLines(logged.String(), "download or content check failed"); got != 0 {
		t.Fatalf("logged %d per-file WARN lines for a lost session, want 0:\n%s", got, logged.String())
	}
	if got := warnLines(logged.String(), "storage session ended"); got != 1 {
		t.Fatalf("logged %d abort WARN lines, want exactly 1:\n%s", got, logged.String())
	}
}

func TestVerifyIntegrity_SessionLostBeforeAnythingVerifiedIsFailed(t *testing.T) {
	defer setVerifyConcurrencyForTest(1)()
	defer setDownloadTimeoutFloorForTest(time.Hour)()
	p := newScriptedDownloadProvider(t, "verify-session-lost-zero", 20)
	p.objectErr = sessionGoneFrom("verify-session-lost-zero", 0)

	result, err := VerifyIntegrityWithOptions(context.Background(), p, "verify-session-lost-zero", VerifyOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := p.startedObjects(); got != 1 {
		t.Fatalf("started %d downloads, want 1", got)
	}
	if result.Status != "failed" || result.Code != sessionLostCode || result.FilesFailed != 0 || result.FilesUnchecked != 20 {
		t.Fatalf("result = %+v, want failed/%s with 0 failed and 20 unchecked", result, sessionLostCode)
	}
}

// Every worker meets the lost session at once. None of them may count its
// file failed or log a per-file WARN, however the cancellation races.
func TestVerifyIntegrity_SessionLostOnEveryWorkerAtOnceFailsNoFile(t *testing.T) {
	defer setVerifyConcurrencyForTest(8)()
	defer setDownloadTimeoutFloorForTest(time.Hour)()
	logged := captureBackupLogs(t)
	const n = 200
	p := newScriptedDownloadProvider(t, "verify-session-lost-race", n)
	var arrived atomic.Int32
	allIn := make(chan struct{})
	p.objectErr = func(ctx context.Context, _ string) error {
		if arrived.Add(1) == 8 {
			close(allIn)
		}
		select {
		case <-allIn:
		case <-time.After(5 * time.Second):
		}
		return errTestSessionGone
	}

	var result *VerifyResult
	var err error
	runWithWatchdog(t, 20*time.Second, func() {
		result, err = VerifyIntegrityWithOptions(context.Background(), p, "verify-session-lost-race", VerifyOptions{})
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.FilesFailed != 0 || len(result.FailedFiles) != 0 {
		t.Fatalf("filesFailed=%d failedFiles=%d, want 0/0", result.FilesFailed, len(result.FailedFiles))
	}
	if got := p.startedObjects(); got > 16 {
		t.Fatalf("started %d of %d downloads after the session was lost, want at most two rounds of 8", got, n)
	}
	if result.FilesUnchecked != n || result.Status != "failed" || result.Code != sessionLostCode {
		t.Fatalf("result = unchecked %d status %q code %q, want %d/failed/%s", result.FilesUnchecked, result.Status, result.Code, n, sessionLostCode)
	}
	if got := warnLines(logged.String(), "download or content check failed"); got != 0 {
		t.Fatalf("logged %d per-file WARN lines, want 0", got)
	}
}

// A stop (caller cancel) closes the session too; it is still a stop.
func TestVerifyIntegrity_CallerCancelWithSessionLossStillReturnsError(t *testing.T) {
	defer setVerifyConcurrencyForTest(1)()
	defer setDownloadTimeoutFloorForTest(time.Hour)()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := newScriptedDownloadProvider(t, "verify-session-stop", 10)
	p.objectErr = func(context.Context, string) error {
		cancel()
		return fmt.Errorf("%w: closed", providers.ErrStorageSessionUnavailable)
	}
	_, err := VerifyIntegrityWithOptions(ctx, p, "verify-session-stop", VerifyOptions{TimeBudget: time.Hour})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want the caller's cancellation", err)
	}
}

// The time budget ending a run keeps its own status and message: a lost
// session is only reported when it is what ended the run.
func TestVerifyIntegrity_TimeBudgetBeforeSessionLossKeepsBudgetReason(t *testing.T) {
	defer setVerifyConcurrencyForTest(1)()
	defer setDownloadTimeoutFloorForTest(time.Hour)()
	p := newScriptedDownloadProvider(t, "verify-budget-then-session", 6, 2)
	budget := useManualBudgetForTest(t)
	p.onStall = budget.expire
	p.objectErr = sessionGoneFrom("verify-budget-then-session", 3)

	result, err := VerifyIntegrityWithOptions(context.Background(), p, "verify-budget-then-session",
		VerifyOptions{TimeBudget: time.Minute})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Code == sessionLostCode || !strings.Contains(result.Error, "time budget") {
		t.Fatalf("code=%q error=%q, want the time-budget reason", result.Code, result.Error)
	}
	if result.Status != "partial" || result.FilesVerified != 2 || result.FilesUnchecked != 4 {
		t.Fatalf("result = %+v, want partial with 2 verified, 4 unchecked", result)
	}
}

func TestVerifyIntegrity_SessionLostDuringManifestIsFailedWithCode(t *testing.T) {
	p := newScriptedDownloadProvider(t, "verify-session-manifest", 3)
	p.manifestErr = errTestSessionGone
	result, err := VerifyIntegrityWithOptions(context.Background(), p, "verify-session-manifest", VerifyOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "failed" || result.Code != sessionLostCode {
		t.Fatalf("status=%q code=%q, want failed/%s", result.Status, result.Code, sessionLostCode)
	}
	if !strings.Contains(result.Error, "storage session ended before the snapshot manifest") {
		t.Fatalf("error = %q, want it to say the session ended during the manifest download", result.Error)
	}
	if p.startedObjects() != 0 {
		t.Fatalf("started %d object downloads after the manifest failed", p.startedObjects())
	}
}

func TestTestRestore_SessionLostMidRunStopsEarlyAndCleansUp(t *testing.T) {
	defer setVerifyConcurrencyForTest(1)()
	defer setDownloadTimeoutFloorForTest(time.Hour)()
	logged := captureBackupLogs(t)
	const n = 30
	p := newScriptedDownloadProvider(t, "restore-session-lost", n)
	p.objectErr = sessionGoneFrom("restore-session-lost", 2)

	var result *TestRestoreResult
	var err error
	runWithWatchdog(t, 10*time.Second, func() {
		result, err = TestRestoreWithOptions(context.Background(), p, "restore-session-lost", t.TempDir(),
			VerifyOptions{TimeBudget: time.Hour})
	})
	if err != nil {
		t.Fatalf("a lost session must not be an error, got %v", err)
	}
	if got := p.startedObjects(); got != 3 {
		t.Fatalf("started %d downloads, want 3", got)
	}
	if result.FilesVerified != 2 || result.FilesFailed != 0 || result.FilesUnchecked != n-2 {
		t.Fatalf("verified=%d failed=%d unchecked=%d, want 2/0/%d", result.FilesVerified, result.FilesFailed, result.FilesUnchecked, n-2)
	}
	if result.Status != "partial" || result.Code != sessionLostCode {
		t.Fatalf("status=%q code=%q, want partial/%s", result.Status, result.Code, sessionLostCode)
	}
	if !strings.Contains(result.Error, "storage session ended") || !strings.Contains(result.Error, "checked 2 of 30 files") {
		t.Fatalf("error = %q, want the session-ended reason with progress", result.Error)
	}
	if !result.CleanedUp {
		t.Fatal("restore directory was not cleaned up after the session was lost")
	}
	if _, statErr := os.Stat(result.RestorePath); !os.IsNotExist(statErr) {
		t.Fatalf("restore path still exists: %q", result.RestorePath)
	}
	if got := warnLines(logged.String(), "download or content check failed"); got != 0 {
		t.Fatalf("logged %d per-file WARN lines, want 0", got)
	}
}

func TestTestRestore_SessionLostBeforeAnythingVerifiedIsFailed(t *testing.T) {
	defer setVerifyConcurrencyForTest(1)()
	defer setDownloadTimeoutFloorForTest(time.Hour)()
	p := newScriptedDownloadProvider(t, "restore-session-lost-zero", 5)
	p.objectErr = sessionGoneFrom("restore-session-lost-zero", 0)
	result, err := TestRestoreWithOptions(context.Background(), p, "restore-session-lost-zero", t.TempDir(), VerifyOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "failed" || result.Code != sessionLostCode || result.FilesFailed != 0 || !result.CleanedUp {
		t.Fatalf("result = %+v, want failed/%s, 0 failed, cleaned up", result, sessionLostCode)
	}
}

func TestTestRestore_SessionLostDuringManifestIsFailedWithCode(t *testing.T) {
	p := newScriptedDownloadProvider(t, "restore-session-manifest", 3)
	p.manifestErr = errTestSessionGone
	result, err := TestRestoreWithOptions(context.Background(), p, "restore-session-manifest", t.TempDir(), VerifyOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "failed" || result.Code != sessionLostCode || !strings.Contains(result.Error, "storage session ended") {
		t.Fatalf("result = %+v, want failed/%s with a session-ended reason", result, sessionLostCode)
	}
}

func TestTestRestore_CallerCancelWithSessionLossStillReturnsError(t *testing.T) {
	defer setVerifyConcurrencyForTest(1)()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := newScriptedDownloadProvider(t, "restore-session-stop", 10)
	p.objectErr = func(context.Context, string) error {
		cancel()
		return fmt.Errorf("%w: closed", providers.ErrStorageSessionUnavailable)
	}
	_, err := TestRestoreWithOptions(ctx, p, "restore-session-stop", t.TempDir(), VerifyOptions{TimeBudget: time.Hour})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want the caller's cancellation", err)
	}
}
