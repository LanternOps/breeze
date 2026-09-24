package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// scriptedDownloadProvider is a BackupProvider + providers.ContextDownloader
// fake for the #6598 verify/test-restore tests. Paths in stall block until
// the download's context ends (the mid-body stall the S3 client could not
// escape); every download takes delay; the peak number of concurrent
// downloads is recorded. The plain Download blocks on a stalled path until
// the test ends, which is what the uncancellable pre-#6598 path did.
type scriptedDownloadProvider struct {
	manifestKey string
	manifest    []byte
	files       map[string][]byte
	stall       map[string]bool
	delay       time.Duration
	release     chan struct{}

	inflight  atomic.Int32
	peak      atomic.Int32
	mu        sync.Mutex
	started   []string
	ctxCalled atomic.Int32
}

func newScriptedDownloadProvider(t *testing.T, snapshotID string, n int, stall ...int) *scriptedDownloadProvider {
	t.Helper()
	p := &scriptedDownloadProvider{
		manifestKey: path.Join(snapshotRootDir, snapshotID, snapshotManifestKey),
		files:       map[string][]byte{},
		stall:       map[string]bool{},
		release:     make(chan struct{}),
	}
	t.Cleanup(func() { close(p.release) })
	stalled := map[int]bool{}
	for _, i := range stall {
		stalled[i] = true
	}
	snap := Snapshot{ID: snapshotID}
	for i := 0; i < n; i++ {
		data := []byte(fmt.Sprintf("file-%03d", i))
		backupPath := path.Join(snapshotRootDir, snapshotID, "files", fmt.Sprintf("f%03d.txt", i))
		p.files[backupPath] = data
		if stalled[i] {
			p.stall[backupPath] = true
		}
		snap.Files = append(snap.Files, SnapshotFile{
			SourcePath: fmt.Sprintf("/data/f%03d.txt", i),
			BackupPath: backupPath,
			Size:       int64(len(data)),
		})
	}
	manifest, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	p.manifest = manifest
	return p
}

func (p *scriptedDownloadProvider) Upload(string, string) error   { return nil }
func (p *scriptedDownloadProvider) List(string) ([]string, error) { return nil, nil }
func (p *scriptedDownloadProvider) Delete(string) error           { return nil }

func (p *scriptedDownloadProvider) Download(remotePath, localPath string) error {
	return p.download(nil, remotePath, localPath)
}

func (p *scriptedDownloadProvider) DownloadContext(ctx context.Context, remotePath, localPath string) error {
	p.ctxCalled.Add(1)
	return p.download(ctx, remotePath, localPath)
}

func (p *scriptedDownloadProvider) download(ctx context.Context, remotePath, localPath string) error {
	if remotePath == p.manifestKey {
		return os.WriteFile(localPath, p.manifest, 0o644)
	}
	p.mu.Lock()
	p.started = append(p.started, remotePath)
	p.mu.Unlock()

	n := p.inflight.Add(1)
	defer p.inflight.Add(-1)
	for {
		old := p.peak.Load()
		if n <= old || p.peak.CompareAndSwap(old, n) {
			break
		}
	}

	var done <-chan struct{}
	if ctx != nil {
		done = ctx.Done()
	}
	if p.stall[remotePath] {
		select {
		case <-done:
			return fmt.Errorf("read body: %w", ctx.Err())
		case <-p.release:
			return errors.New("released at test end")
		}
	}
	if p.delay > 0 {
		select {
		case <-done:
			return fmt.Errorf("read body: %w", ctx.Err())
		case <-time.After(p.delay):
		}
	}
	data, ok := p.files[remotePath]
	if !ok {
		return os.ErrNotExist
	}
	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(localPath, data, 0o644)
}

// runWithWatchdog fails the test (instead of hanging the package) when fn
// does not return within limit — the pre-#6598 behaviour on a stalled object.
func runWithWatchdog(t *testing.T, limit time.Duration, fn func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		fn()
	}()
	select {
	case <-done:
	case <-time.After(limit):
		t.Fatalf("run did not return within %v: one stalled download holds the whole run", limit)
	}
}

// A single object whose download stalls mid-body must fail THAT file once
// its per-file deadline passes, and the run must carry on with the rest.
func TestVerifyIntegrity_StalledDownloadFailsOnlyThatFile(t *testing.T) {
	defer setDownloadTimeoutFloorForTest(100 * time.Millisecond)()
	p := newScriptedDownloadProvider(t, "verify-stall", 6, 2)

	var result *VerifyResult
	var err error
	runWithWatchdog(t, 10*time.Second, func() {
		result, err = VerifyIntegrityContext(context.Background(), p, "verify-stall")
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.FilesVerified != 5 || result.FilesFailed != 1 {
		t.Fatalf("verified=%d failed=%d, want 5/1 (result=%+v)", result.FilesVerified, result.FilesFailed, result)
	}
	if result.Status != "partial" {
		t.Fatalf("status = %q, want partial", result.Status)
	}
	if len(result.FailedFiles) != 1 || !strings.HasSuffix(result.FailedFiles[0], "f002.txt") {
		t.Fatalf("failedFiles = %v, want only f002.txt", result.FailedFiles)
	}
}

func TestTestRestore_StalledDownloadFailsOnlyThatFile(t *testing.T) {
	defer setDownloadTimeoutFloorForTest(100 * time.Millisecond)()
	p := newScriptedDownloadProvider(t, "restore-stall", 6, 4)

	var result *TestRestoreResult
	var err error
	runWithWatchdog(t, 10*time.Second, func() {
		result, err = TestRestoreContext(context.Background(), p, "restore-stall", t.TempDir(), nil)
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.FilesVerified != 5 || result.FilesFailed != 1 || result.Status != "partial" {
		t.Fatalf("verified=%d failed=%d status=%q, want 5/1 partial", result.FilesVerified, result.FilesFailed, result.Status)
	}
	if !result.CleanedUp {
		t.Fatal("restore directory was not cleaned up")
	}
}

// Serial per-object round trips alone exceed the 2 h budget on a ~200k-file
// snapshot (#6598), so downloads must overlap.
func TestVerifyIntegrity_DownloadsConcurrently(t *testing.T) {
	p := newScriptedDownloadProvider(t, "verify-concurrent", 24)
	p.delay = 20 * time.Millisecond

	result, err := VerifyIntegrityContext(context.Background(), p, "verify-concurrent")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "passed" || result.FilesVerified != 24 {
		t.Fatalf("status=%q verified=%d, want passed/24", result.Status, result.FilesVerified)
	}
	if peak := p.peak.Load(); peak < 2 || int(peak) > verifyDownloadConcurrency {
		t.Fatalf("peak concurrent downloads = %d, want between 2 and %d", peak, verifyDownloadConcurrency)
	}
	if p.ctxCalled.Load() == 0 {
		t.Fatal("verify never used the context-aware download path")
	}
}

func TestTestRestore_DownloadsConcurrently(t *testing.T) {
	p := newScriptedDownloadProvider(t, "restore-concurrent", 24)
	p.delay = 20 * time.Millisecond

	result, err := TestRestoreContext(context.Background(), p, "restore-concurrent", t.TempDir(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "passed" || result.FilesVerified != 24 {
		t.Fatalf("status=%q verified=%d, want passed/24", result.Status, result.FilesVerified)
	}
	if peak := p.peak.Load(); peak < 2 {
		t.Fatalf("peak concurrent downloads = %d, want >= 2", peak)
	}
}

// When the run's overall time budget runs out, the counts gathered so far
// must come back as a result — not be discarded behind a timeout error that
// the server renders as "0 files ok 0 files failed" (#6598).
func TestVerifyIntegrity_TimeBudgetReturnsPartialCounts(t *testing.T) {
	defer setVerifyConcurrencyForTest(1)()
	defer setDownloadTimeoutFloorForTest(time.Hour)()
	// Files 0-2 are fine; file 3 stalls past the budget; 4-5 never start.
	p := newScriptedDownloadProvider(t, "verify-budget", 6, 3)

	var result *VerifyResult
	var err error
	runWithWatchdog(t, 10*time.Second, func() {
		result, err = VerifyIntegrityWithOptions(context.Background(), p, "verify-budget",
			VerifyOptions{TimeBudget: 300 * time.Millisecond})
	})
	if err != nil {
		t.Fatalf("budget exhaustion must not be an error (it discards the counts), got %v", err)
	}
	if result.FilesVerified != 3 || result.FilesFailed != 0 {
		t.Fatalf("verified=%d failed=%d, want 3/0", result.FilesVerified, result.FilesFailed)
	}
	if result.FilesUnchecked != 3 {
		t.Fatalf("filesUnchecked = %d, want 3 (the stalled file and the two never started)", result.FilesUnchecked)
	}
	if result.Status != "partial" {
		t.Fatalf("status = %q, want partial (never passed when files went unchecked)", result.Status)
	}
	if !strings.Contains(result.Error, "time budget") || !strings.Contains(result.Error, "3 of 6") {
		t.Fatalf("error = %q, want it to name the time budget and the 3 of 6 progress", result.Error)
	}
}

func TestVerifyIntegrity_TimeBudgetWithNothingCheckedIsFailed(t *testing.T) {
	defer setVerifyConcurrencyForTest(1)()
	defer setDownloadTimeoutFloorForTest(time.Hour)()
	p := newScriptedDownloadProvider(t, "verify-budget-zero", 3, 0)

	result, err := VerifyIntegrityWithOptions(context.Background(), p, "verify-budget-zero",
		VerifyOptions{TimeBudget: 200 * time.Millisecond})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "failed" || result.FilesUnchecked != 3 {
		t.Fatalf("status=%q unchecked=%d, want failed/3", result.Status, result.FilesUnchecked)
	}
}

func TestTestRestore_TimeBudgetReturnsPartialCountsAndCleansUp(t *testing.T) {
	defer setVerifyConcurrencyForTest(1)()
	defer setDownloadTimeoutFloorForTest(time.Hour)()
	p := newScriptedDownloadProvider(t, "restore-budget", 5, 2)

	var result *TestRestoreResult
	var err error
	runWithWatchdog(t, 10*time.Second, func() {
		result, err = TestRestoreWithOptions(context.Background(), p, "restore-budget", t.TempDir(),
			VerifyOptions{TimeBudget: 300 * time.Millisecond})
	})
	if err != nil {
		t.Fatalf("budget exhaustion must not be an error, got %v", err)
	}
	if result.FilesVerified != 2 || result.FilesFailed != 0 || result.FilesUnchecked != 3 {
		t.Fatalf("verified=%d failed=%d unchecked=%d, want 2/0/3", result.FilesVerified, result.FilesFailed, result.FilesUnchecked)
	}
	if result.Status != "partial" || !strings.Contains(result.Error, "time budget") {
		t.Fatalf("status=%q error=%q, want partial with a time-budget reason", result.Status, result.Error)
	}
	if !result.CleanedUp {
		t.Fatal("restore directory was not cleaned up after the budget ran out")
	}
	if _, statErr := os.Stat(result.RestorePath); !os.IsNotExist(statErr) {
		t.Fatalf("restore path still exists: %q", result.RestorePath)
	}
}

// A caller cancel (backup_stop) is still an error, as before — only the
// run's own time budget converts into a partial result.
func TestVerifyIntegrity_ParentCancelStillReturnsError(t *testing.T) {
	defer setDownloadTimeoutFloorForTest(time.Hour)()
	p := newScriptedDownloadProvider(t, "verify-parent-cancel", 4, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	var err error
	runWithWatchdog(t, 10*time.Second, func() {
		_, err = VerifyIntegrityWithOptions(ctx, p, "verify-parent-cancel", VerifyOptions{TimeBudget: time.Hour})
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want the caller's context error", err)
	}
}

func TestVerifyIntegrity_ReportsProgress(t *testing.T) {
	p := newScriptedDownloadProvider(t, "verify-progress", 10)
	var calls []int
	var total int
	result, err := VerifyIntegrityWithOptions(context.Background(), p, "verify-progress", VerifyOptions{
		Progress: func(done, tot int) {
			calls = append(calls, done)
			total = tot
		},
	})
	if err != nil || result.Status != "passed" {
		t.Fatalf("err=%v status=%q", err, result.Status)
	}
	if total != 10 || len(calls) != 10 {
		t.Fatalf("progress calls=%v total=%d, want 10 calls with total 10", calls, total)
	}
	for i, done := range calls {
		if done != i+1 {
			t.Fatalf("progress done sequence = %v, want 1..10 in order", calls)
		}
	}
}

func TestTestRestore_ReportsProgressPerManifestEntry(t *testing.T) {
	p := newScriptedDownloadProvider(t, "restore-progress", 7)
	var last, total, n int
	result, err := TestRestoreContext(context.Background(), p, "restore-progress", t.TempDir(), func(done, tot int) {
		n++
		last, total = done, tot
	})
	if err != nil || result.Status != "passed" {
		t.Fatalf("err=%v status=%q", err, result.Status)
	}
	if n != 7 || last != 7 || total != 7 {
		t.Fatalf("progress n=%d last=%d total=%d, want 7/7/7", n, last, total)
	}
}

// Results must be deterministic regardless of which worker finished first:
// failed files and warnings are reported in manifest order.
func TestVerifyIntegrity_ConcurrentResultsKeepManifestOrder(t *testing.T) {
	p := newScriptedDownloadProvider(t, "verify-order", 12)
	// Remove every third object so several workers fail at once.
	var want []string
	var snap Snapshot
	if err := json.Unmarshal(p.manifest, &snap); err != nil {
		t.Fatal(err)
	}
	for i, f := range snap.Files {
		if i%3 == 0 {
			delete(p.files, f.BackupPath)
			want = append(want, f.BackupPath)
		}
	}
	result, err := VerifyIntegrityContext(context.Background(), p, "verify-order")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(result.FailedFiles, ",") != strings.Join(want, ",") {
		t.Fatalf("failedFiles = %v, want manifest order %v", result.FailedFiles, want)
	}
}
