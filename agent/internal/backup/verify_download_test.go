package backup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
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
	// stallManifest makes the manifest download itself stall (context-aware
	// path only).
	stallManifest bool
	// manifestChunks > 0 delivers the manifest in that many pieces,
	// manifestChunkDelay apart, written straight into the destination file
	// the way a provider's io.Copy does: a slow but progressing transfer.
	// With manifestStallAfterFirstChunk the first piece arrives and then
	// nothing more: a mid-body stall.
	manifestChunks               int
	manifestChunkDelay           time.Duration
	manifestStallAfterFirstChunk bool
	// manifestHookOnly buffers the trickled manifest in memory and writes
	// the file only at the end, so the ONLY progress signal is the
	// providers.WithDownloadProgress callback (no file growth to observe).
	manifestHookOnly bool
	// manifestShrinkAfterFirstChunk writes the first piece and then keeps
	// SHRINKING the destination file one byte at a time without ever
	// delivering more: size changes, but no new data arrives.
	manifestShrinkAfterFirstChunk bool

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
		if p.stallManifest {
			select {
			case <-ctx.Done():
				return fmt.Errorf("read body: %w", ctx.Err())
			case <-p.release:
				return errors.New("released at test end")
			}
		}
		if p.manifestChunks > 0 {
			return p.trickleManifest(ctx, localPath)
		}
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

// trickleManifest writes the manifest to localPath in p.manifestChunks
// pieces, p.manifestChunkDelay apart, honouring ctx between pieces.
func (p *scriptedDownloadProvider) trickleManifest(ctx context.Context, localPath string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	f, err := os.Create(localPath)
	if err != nil {
		return err
	}
	defer f.Close()
	var w io.Writer = f
	var buf bytes.Buffer
	if p.manifestHookOnly {
		w = providers.DownloadProgressWriter(ctx, &buf)
		defer func() { _, _ = f.Write(buf.Bytes()) }()
	}
	chunk := (len(p.manifest) + p.manifestChunks - 1) / p.manifestChunks
	for off := 0; off < len(p.manifest); off += chunk {
		if off > 0 {
			if p.manifestShrinkAfterFirstChunk {
				for size := int64(off); ; size-- {
					if size > 0 {
						if err := f.Truncate(size - 1); err != nil {
							return err
						}
					}
					select {
					case <-ctx.Done():
						return fmt.Errorf("read body: %w", ctx.Err())
					case <-p.release:
						return errors.New("released at test end")
					case <-time.After(20 * time.Millisecond):
					}
				}
			}
			if p.manifestStallAfterFirstChunk {
				select {
				case <-ctx.Done():
					return fmt.Errorf("read body: %w", ctx.Err())
				case <-p.release:
					return errors.New("released at test end")
				}
			}
			select {
			case <-ctx.Done():
				return fmt.Errorf("read body: %w", ctx.Err())
			case <-time.After(p.manifestChunkDelay):
			}
		}
		end := min(off+chunk, len(p.manifest))
		if _, err := w.Write(p.manifest[off:end]); err != nil {
			return err
		}
	}
	return nil
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

// Two manifest entries whose restore paths differ only by case must not
// share a destination: on a case-insensitive volume, concurrent workers would
// write one file and fail each other's size checks.
func TestTestRestoreDestinations_CaseCollisionGetsDistinctPath(t *testing.T) {
	root := t.TempDir()
	files := []SnapshotFile{
		{SourcePath: "/data/Report.txt", BackupPath: "a", Size: 1},
		{SourcePath: "/data/report.txt", BackupPath: "b", Size: 1},
		{SourcePath: "/data/other.txt", BackupPath: "c", Size: 1},
	}
	dests, errs := testRestoreDestinations(root, files)
	for i, err := range errs {
		if err != nil {
			t.Fatalf("entry %d: unexpected path error %v", i, err)
		}
	}
	if strings.EqualFold(dests[0], dests[1]) {
		t.Fatalf("case-colliding entries share a destination: %q / %q", dests[0], dests[1])
	}
	if dests[2] != filepath.Join(root, "data", "other.txt") {
		t.Fatalf("non-colliding entry moved: %q", dests[2])
	}
}

func TestTestRestore_CaseCollidingEntriesBothVerify(t *testing.T) {
	p := newScriptedDownloadProvider(t, "restore-case", 2)
	var snap Snapshot
	if err := json.Unmarshal(p.manifest, &snap); err != nil {
		t.Fatal(err)
	}
	// Entry 1 restores to the same path as entry 0 up to case, with a
	// different size, so a shared file fails one of the two size checks.
	snap.Files[1].SourcePath = strings.ToUpper(snap.Files[0].SourcePath)
	longer := []byte("a considerably longer object body")
	p.files[snap.Files[1].BackupPath] = longer
	snap.Files[1].Size = int64(len(longer))
	manifest, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	p.manifest = manifest

	result, err := TestRestoreContext(context.Background(), p, "restore-case", t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "passed" || result.FilesVerified != 2 {
		t.Fatalf("status=%q verified=%d failed=%v, want passed/2", result.Status, result.FilesVerified, result.FailedFiles)
	}
}

// Progress counts only entries that reached a verdict: files interrupted or
// never started because the budget ran out are not reported as done.
func TestVerifyIntegrity_ProgressUnderBudgetCountsOnlyFinishedFiles(t *testing.T) {
	defer setVerifyConcurrencyForTest(2)()
	defer setDownloadTimeoutFloorForTest(time.Hour)()
	p := newScriptedDownloadProvider(t, "verify-progress-budget", 8, 3, 4)

	var calls, last int
	result, err := VerifyIntegrityWithOptions(context.Background(), p, "verify-progress-budget", VerifyOptions{
		TimeBudget: 300 * time.Millisecond,
		Progress: func(done, total int) {
			calls++
			last = done
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.FilesUnchecked == 0 {
		t.Fatalf("expected unchecked files, got %+v", result)
	}
	checked := result.FilesVerified + result.FilesFailed
	if calls != checked || last != checked {
		t.Fatalf("progress calls=%d last=%d, want both = %d checked files (unchecked=%d)", calls, last, checked, result.FilesUnchecked)
	}
}

// A budget that runs out while the manifest itself is downloading must not
// claim the manifest is missing.
func TestVerifyIntegrity_BudgetDuringManifestIsNotReportedAsMissing(t *testing.T) {
	p := newScriptedDownloadProvider(t, "verify-manifest-budget", 1)
	p.stallManifest = true

	var result *VerifyResult
	var err error
	runWithWatchdog(t, 10*time.Second, func() {
		result, err = VerifyIntegrityWithOptions(context.Background(), p, "verify-manifest-budget",
			VerifyOptions{TimeBudget: 200 * time.Millisecond})
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "failed" || strings.Contains(result.Error, "not found") || !strings.Contains(result.Error, "time budget") {
		t.Fatalf("status=%q error=%q, want failed with a time-budget reason, not 'not found'", result.Status, result.Error)
	}
}

// A manifest's size is unknown until it has downloaded, so it cannot get a
// size-sized deadline. A large manifest on a slow link that keeps delivering
// bytes must NOT be cut off by the per-file floor: before this fix a 46 MiB
// manifest at 100 KB/s failed the whole run at exactly 5 m (#6929 lab).
//
// Both progress signals are covered: the destination file growing (what an
// io.Copy into it looks like) and the provider's progress callback alone.
func TestVerifyIntegrity_SlowButProgressingManifestSucceeds(t *testing.T) {
	for _, tc := range []struct {
		name     string
		hookOnly bool
	}{
		{"file growth", false},
		{"progress callback only", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer setDownloadTimeoutFloorForTest(150 * time.Millisecond)()
			p := newScriptedDownloadProvider(t, "verify-slow-manifest", 3)
			p.manifestChunks = 12
			p.manifestChunkDelay = 50 * time.Millisecond // ~550 ms in total, well past the floor
			p.manifestHookOnly = tc.hookOnly

			var result *VerifyResult
			var err error
			runWithWatchdog(t, 10*time.Second, func() {
				result, err = VerifyIntegrityWithOptions(context.Background(), p, "verify-slow-manifest", VerifyOptions{})
			})
			if err != nil {
				t.Fatal(err)
			}
			if result.Status != "passed" || result.FilesVerified != 3 {
				t.Fatalf("status=%q verified=%d error=%q, want passed with 3 verified", result.Status, result.FilesVerified, result.Error)
			}
		})
	}
}

// A provider that reports no progress at all past the first chunk (no
// callback, no file growth) is a stall even with the callback path in use.
func TestVerifyIntegrity_StalledManifestHookOnlyFails(t *testing.T) {
	defer setDownloadTimeoutFloorForTest(150 * time.Millisecond)()
	p := newScriptedDownloadProvider(t, "verify-stalled-hook", 3)
	p.manifestChunks = 4
	p.manifestStallAfterFirstChunk = true
	p.manifestHookOnly = true

	var result *VerifyResult
	var err error
	runWithWatchdog(t, 10*time.Second, func() {
		result, err = VerifyIntegrityWithOptions(context.Background(), p, "verify-stalled-hook", VerifyOptions{})
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "failed" || !strings.Contains(result.Error, "manifest download stalled") {
		t.Fatalf("status=%q error=%q, want failed with a manifest-stall reason", result.Status, result.Error)
	}
}

// A destination file that changes size by SHRINKING (a provider, or
// FallbackProvider's next candidate, re-creating it) delivered no new data
// and must not keep the stall window open forever.
func TestVerifyIntegrity_ShrinkingManifestFileIsNotProgress(t *testing.T) {
	defer setDownloadTimeoutFloorForTest(150 * time.Millisecond)()
	p := newScriptedDownloadProvider(t, "verify-shrinking-manifest", 3)
	p.manifestChunks = 2
	p.manifestShrinkAfterFirstChunk = true

	var result *VerifyResult
	var err error
	runWithWatchdog(t, 5*time.Second, func() {
		result, err = VerifyIntegrityWithOptions(context.Background(), p, "verify-shrinking-manifest", VerifyOptions{})
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "failed" || !strings.Contains(result.Error, "manifest download stalled") {
		t.Fatalf("status=%q error=%q, want failed with a manifest-stall reason", result.Status, result.Error)
	}
}

// A manifest the provider positively reports missing is still "not found";
// any other transport failure is not.
func TestManifestDownloadError_OnlyMissingObjectIsNotFound(t *testing.T) {
	ctx := context.Background()
	if got := manifestDownloadError(ctx, VerifyOptions{}, fmt.Errorf("get: %w", providers.ErrObjectNotFound)); !strings.HasPrefix(got, "manifest not found") {
		t.Fatalf("ErrObjectNotFound => %q, want 'manifest not found' prefix", got)
	}
	if got := manifestDownloadError(ctx, VerifyOptions{}, errors.New("403 AccessDenied")); strings.Contains(got, "not found") {
		t.Fatalf("access error => %q, must not claim the manifest is missing", got)
	}
	// A DESTINATION-side ENOENT (the temp dir vanished) says nothing about
	// the remote object; providers map a missing source to ErrObjectNotFound.
	destErr := fmt.Errorf("failed to create local destination file: %w",
		&fs.PathError{Op: "open", Path: "/tmp/gone/verify-manifest.json", Err: fs.ErrNotExist})
	if got := manifestDownloadError(ctx, VerifyOptions{}, destErr); strings.Contains(got, "not found") {
		t.Fatalf("destination ENOENT => %q, must not claim the manifest is missing", got)
	}
}

func TestTestRestore_SlowButProgressingManifestSucceeds(t *testing.T) {
	defer setDownloadTimeoutFloorForTest(150 * time.Millisecond)()
	p := newScriptedDownloadProvider(t, "restore-slow-manifest", 3)
	p.manifestChunks = 12
	p.manifestChunkDelay = 50 * time.Millisecond

	var result *TestRestoreResult
	var err error
	runWithWatchdog(t, 10*time.Second, func() {
		result, err = TestRestoreWithOptions(context.Background(), p, "restore-slow-manifest", t.TempDir(), VerifyOptions{})
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "passed" || result.FilesVerified != 3 {
		t.Fatalf("status=%q verified=%d error=%q, want passed with 3 verified", result.Status, result.FilesVerified, result.Error)
	}
}

// A manifest that stops delivering bytes must still fail in bounded time,
// and the reason must say it stalled, not that the manifest is missing.
func TestVerifyIntegrity_StalledManifestFailsWithStallReason(t *testing.T) {
	defer setDownloadTimeoutFloorForTest(150 * time.Millisecond)()
	p := newScriptedDownloadProvider(t, "verify-stalled-manifest", 3)
	p.manifestChunks = 4
	p.manifestStallAfterFirstChunk = true

	var result *VerifyResult
	var err error
	began := time.Now()
	runWithWatchdog(t, 10*time.Second, func() {
		result, err = VerifyIntegrityWithOptions(context.Background(), p, "verify-stalled-manifest", VerifyOptions{})
	})
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(began); elapsed > 3*time.Second {
		t.Fatalf("stalled manifest took %v to fail, want about the 150ms no-progress window", elapsed)
	}
	if result.Status != "failed" || strings.Contains(result.Error, "not found") ||
		!strings.Contains(result.Error, "manifest download stalled") {
		t.Fatalf("status=%q error=%q, want failed with a manifest-stall reason, not 'not found'", result.Status, result.Error)
	}
}

func TestTestRestore_StalledManifestFailsWithStallReason(t *testing.T) {
	defer setDownloadTimeoutFloorForTest(150 * time.Millisecond)()
	p := newScriptedDownloadProvider(t, "restore-stalled-manifest", 3)
	p.manifestChunks = 4
	p.manifestStallAfterFirstChunk = true

	var result *TestRestoreResult
	var err error
	runWithWatchdog(t, 10*time.Second, func() {
		result, err = TestRestoreWithOptions(context.Background(), p, "restore-stalled-manifest", t.TempDir(), VerifyOptions{})
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "failed" || strings.Contains(result.Error, "not found") ||
		!strings.Contains(result.Error, "manifest download stalled") {
		t.Fatalf("status=%q error=%q, want failed with a manifest-stall reason, not 'not found'", result.Status, result.Error)
	}
}
