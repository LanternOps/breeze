package backup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// fileObjects counts the file objects (not control objects) stored.
func (p *poolProvider) fileObjects() int {
	p.mockProvider.mu.Lock()
	defer p.mockProvider.mu.Unlock()
	n := 0
	for k := range p.files {
		if isFileObject(k) {
			n++
		}
	}
	return n
}

// A journaled run stopped while files behind a slow head have already
// finished keeps its prefix, journals only the files accounted in walk order
// (the finished-but-unaccounted ones are not journaled, so resume uploads
// them again), and a resumed pooled run completes the snapshot with every
// file exactly once, in walk order.
//
// Deterministic: f02 (the head after f00/f01) blocks until the stop; f01's
// upload is held until f03..f05 have landed behind it; the stop is issued
// from the progress callback once f00 and f01 are accounted, so the journal
// holds exactly that prefix on every run.
func TestUploadPool_StopWithJournalThenResume(t *testing.T) {
	defer setUploadConcurrencyForTest(4)()
	defer setProgressThrottleForTest(0)()
	files := poolFiles(t, 10)
	provider := newPoolProvider()
	behindHead := func() int {
		provider.mockProvider.mu.Lock()
		defer provider.mockProvider.mu.Unlock()
		n := 0
		for k := range provider.files {
			if poolKeyIs(k, "f03") || poolKeyIs(k, "f04") || poolKeyIs(k, "f05") {
				n++
			}
		}
		return n
	}
	provider.hold = func(ctx context.Context, remotePath string) error {
		switch {
		case poolKeyIs(remotePath, "f01"):
			// With 4 workers, f03..f05 are admitted as f00, f03 and f04
			// finish; wait (a condition, not a timing guess) until all three
			// have landed behind the blocked head.
			deadline := time.Now().Add(10 * time.Second)
			for behindHead() < 3 {
				if time.Now().After(deadline) {
					return errors.New("f03..f05 never landed")
				}
				time.Sleep(time.Millisecond)
			}
		case poolKeyIs(remotePath, "f02"):
			<-ctx.Done()
			return ctx.Err()
		}
		return nil
	}
	journalDir := t.TempDir()
	journal, _, err := openSnapshotJournal(journalDir, "pool-stop-identity", journalMaxAge)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Runs on the coordinator after each accounted file, before its journal
	// append: stopping at filesDone == 2 still journals f01.
	onProgress := func(filesDone, _ int, _, _ int64, _ string) {
		if filesDone >= 2 {
			cancel()
		}
	}
	if _, err := createSnapshotWithProgress(ctx, provider, files, onProgress, journal, nil, nil); !errors.Is(err, errBackupStopped) {
		t.Fatalf("err = %v, want errBackupStopped", err)
	}
	if got := behindHead(); got != 3 {
		t.Fatalf("%d of f03..f05 landed; the stop was not exercised with finished files behind the head", got)
	}
	if got := provider.fileObjects(); got < 5 {
		t.Fatalf("only %d file objects landed, want f00, f01 and f03..f05 at least", got)
	}
	if active, _, _ := provider.snapshotStats(); active != 0 {
		t.Fatalf("run returned with %d uploads in flight", active)
	}
	provider.mockProvider.mu.Lock()
	deletes := len(provider.deleteCalls)
	provider.mockProvider.mu.Unlock()
	if deletes != 0 {
		t.Fatalf("a journaled stop deleted %d objects; the prefix is the resume state", deletes)
	}

	j2, resumed, err := openSnapshotJournal(journalDir, "pool-stop-identity", journalMaxAge)
	if err != nil || !resumed {
		t.Fatalf("reopen: resumed=%v err=%v", resumed, err)
	}
	for i, f := range files {
		_, ok := j2.Lookup(f.sourcePath, f.size, f.modTime)
		if want := i < 2; ok != want {
			t.Fatalf("file %d journaled=%v, want %v (only the walk-order prefix before the stop)", i, ok, want)
		}
	}

	resumedProvider := newPoolProvider()
	provider.mockProvider.mu.Lock()
	for k, v := range provider.files {
		resumedProvider.files[k] = v
	}
	provider.mockProvider.mu.Unlock()
	snapshot, err := createSnapshotWithProgress(context.Background(), resumedProvider, files, nil, j2, nil, nil)
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if len(snapshot.Files) != len(files) {
		t.Fatalf("resumed manifest has %d files, want %d", len(snapshot.Files), len(files))
	}
	for i, e := range snapshot.Files {
		if e.SourcePath != files[i].sourcePath {
			t.Fatalf("manifest entry %d = %s, want %s (walk order)", i, e.SourcePath, files[i].sourcePath)
		}
	}
	resumedProvider.mockProvider.mu.Lock()
	defer resumedProvider.mockProvider.mu.Unlock()
	for _, c := range resumedProvider.uploadCalls {
		if poolKeyIs(c.remotePath, "f00") || poolKeyIs(c.remotePath, "f01") {
			t.Fatalf("journaled file re-uploaded on resume: %s", c.remotePath)
		}
	}
}

// A stop that arrives while a finished upload waits to be accounted does not
// drop it: the file already landed, so it is accounted and journaled before
// the run ends, and resume does not upload it again.
//
// Deterministic: f00 is held until the coordinator has received f01's
// outcome (it then admits f02, which is observable as a third upload
// starting); the stop is issued from the progress callback while f00 is
// accounted, so f01 is a finished head when the coordinator next looks.
func TestUploadPool_StopKeepsFinishedHeadUpload(t *testing.T) {
	defer setUploadConcurrencyForTest(2)()
	defer setProgressThrottleForTest(0)()
	files := poolFiles(t, 4)
	provider := newPoolProvider()
	provider.hold = func(ctx context.Context, remotePath string) error {
		switch {
		case poolKeyIs(remotePath, "f00"):
			deadline := time.Now().Add(10 * time.Second)
			for {
				if _, _, started := provider.snapshotStats(); started >= 3 {
					return nil
				}
				if time.Now().After(deadline) {
					return errors.New("f02 never started")
				}
				time.Sleep(time.Millisecond)
			}
		case poolKeyIs(remotePath, "f02"):
			<-ctx.Done()
			return ctx.Err()
		}
		return nil
	}
	journalDir := t.TempDir()
	journal, _, err := openSnapshotJournal(journalDir, "pool-finished-head", journalMaxAge)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	onProgress := func(filesDone, _ int, _, _ int64, _ string) {
		if filesDone >= 1 {
			cancel()
		}
	}
	if _, err := createSnapshotWithProgress(ctx, provider, files, onProgress, journal, nil, nil); !errors.Is(err, errBackupStopped) {
		t.Fatalf("err = %v, want errBackupStopped", err)
	}
	j2, resumed, err := openSnapshotJournal(journalDir, "pool-finished-head", journalMaxAge)
	if err != nil || !resumed {
		t.Fatalf("reopen: resumed=%v err=%v", resumed, err)
	}
	for i, f := range files {
		_, ok := j2.Lookup(f.sourcePath, f.size, f.modTime)
		if want := i < 2; ok != want {
			t.Fatalf("file %d journaled=%v, want %v (f01 finished before the stop reached it)", i, ok, want)
		}
	}
}

// sizedFiles writes one file per size.
func sizedFiles(t *testing.T, sizes ...int) []backupFile {
	t.Helper()
	dir := t.TempDir()
	var files []backupFile
	for i, n := range sizes {
		p := filepath.Join(dir, fmt.Sprintf("f%02d.bin", i))
		if err := os.WriteFile(p, []byte(strings.Repeat("z", n)), 0o644); err != nil {
			t.Fatal(err)
		}
		files = append(files, backupFile{sourcePath: p, snapshotPath: fmt.Sprintf("f%02d.bin", i), size: int64(n), modTime: time.Unix(1700000000, 0)})
	}
	return files
}

// The staged-bytes budget: files that together exceed it upload one at a
// time, a file larger than the whole budget still uploads (alone), and files
// that fit together overlap.
func TestUploadPool_StagedBytesBudgetBoundsConcurrentUploads(t *testing.T) {
	defer setUploadConcurrencyForTest(8)()
	old := uploadStagedBytesBudget
	uploadStagedBytesBudget = 100
	defer func() { uploadStagedBytesBudget = old }()

	for _, tc := range []struct {
		name     string
		sizes    []int
		wantPeak func(int) bool
	}{
		{"over budget together", []int{60, 60, 500, 60}, func(p int) bool { return p == 1 }},
		{"fit together", []int{30, 30, 30}, func(p int) bool { return p >= 2 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			provider := newPoolProvider()
			provider.hold = func(context.Context, string) error {
				provider.waitForActive(2, 100*time.Millisecond)
				return nil
			}
			files := sizedFiles(t, tc.sizes...)
			snapshot, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, nil)
			if err != nil {
				t.Fatalf("snapshot: %v", err)
			}
			if len(snapshot.Files) != len(files) {
				t.Fatalf("manifest has %d files, want %d", len(snapshot.Files), len(files))
			}
			if _, peak, _ := provider.snapshotStats(); !tc.wantPeak(peak) {
				t.Fatalf("peak concurrent uploads = %d", peak)
			}
		})
	}
}

// A fence refusal that cannot be waited out ends the run with
// errWriterStillActive, and only after every other worker has returned.
//
// Deterministic: f00 and f01 finish at once, which admits f04 and f05 behind
// the f02 head; f03..f05 block until the run cancels them. f02's refusal is
// held until those three are in flight (#8490: refused at once, the run
// could end before any of them reached the provider, leaving peak at 1).
func TestUploadPool_WriterStillActiveDrainsWorkers(t *testing.T) {
	defer setUploadConcurrencyForTest(4)()
	files := poolFiles(t, 10)
	provider := &stuckFenceProvider{poolProvider: newPoolProvider(), refuseOnceActive: 3}
	provider.ignoresCancel = true
	provider.hold = func(ctx context.Context, remotePath string) error {
		if poolKeyIs(remotePath, "f00") || poolKeyIs(remotePath, "f01") {
			return nil
		}
		<-ctx.Done()
		time.Sleep(20 * time.Millisecond)
		return nil
	}
	_, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, nil)
	if !errors.Is(err, errWriterStillActive) {
		t.Fatalf("err = %v, want errWriterStillActive", err)
	}
	active, peak, _ := provider.snapshotStats()
	provider.close()
	if active != 0 {
		t.Fatalf("run returned with %d uploads in flight", active)
	}
	if peak < 2 {
		t.Fatalf("peak = %d; the abort was not exercised with other uploads in flight", peak)
	}
	time.Sleep(50 * time.Millisecond)
	provider.mu.Lock()
	defer provider.mu.Unlock()
	if provider.startedAfterClose != 0 {
		t.Fatalf("%d uploads started after the run returned", provider.startedAfterClose)
	}
}

// stuckFenceProvider refuses f02 as an earlier writer's, and its fence never
// opens. With refuseOnceActive set, the refusal waits until that many other
// file uploads are in flight, so the run ends with uploads to drain.
type stuckFenceProvider struct {
	*poolProvider
	refuseOnceActive int
}

func (p *stuckFenceProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	if poolKeyIs(remotePath, "f02") {
		if p.refuseOnceActive > 0 && !p.waitForActive(p.refuseOnceActive, 10*time.Second) {
			return fmt.Errorf("test setup: %d other uploads never in flight", p.refuseOnceActive)
		}
		return fmt.Errorf("storage session: %w", providers.ErrPreviousWriterActive)
	}
	return p.poolProvider.UploadContext(ctx, localPath, remotePath)
}

func (p *stuckFenceProvider) Upload(localPath, remotePath string) error {
	return p.UploadContext(context.Background(), localPath, remotePath)
}

func (p *stuckFenceProvider) AwaitWriteAccess(context.Context) error {
	return errors.New("an earlier writer still holds the snapshot")
}

// recordMeasuredForTest wraps statBeforeUpload, the first thing an upload
// worker does, so a test can see which files were handed to a worker at all,
// whether or not the upload then reached the provider. drainUploads waits for
// every worker before createSnapshotWithProgress returns, so the record is
// complete when the run is.
func recordMeasuredForTest(t *testing.T) (measured func(sourcePath string) bool) {
	t.Helper()
	var mu sync.Mutex
	seen := map[string]bool{}
	old := statBeforeUpload
	statBeforeUpload = func(sourcePath string) (filePreUploadMeasurement, error) {
		mu.Lock()
		seen[sourcePath] = true
		mu.Unlock()
		return old(sourcePath)
	}
	t.Cleanup(func() { statBeforeUpload = old })
	return func(sourcePath string) bool {
		mu.Lock()
		defer mu.Unlock()
		return seen[sourcePath]
	}
}

// Once a worker has handed back an outcome that ends the run (source gone,
// writer still active), no further file is admitted: the run will end at that
// file whatever happens next, so a new upload could only run against a dead
// snapshot or a fence that will not open, and be discarded. With one worker
// this is the serial loop's behaviour exactly: the file after the abort point
// is never even started (#8490).
//
// Deterministic: with one worker, admitting the next file after the
// run-ending outcome is not a race. It either happens or it does not, and
// recordMeasuredForTest sees it either way.
func TestUploadPool_RunEndingOutcomeStopsAdmission(t *testing.T) {
	defer setUploadConcurrencyForTest(1)()

	t.Run("source gone", func(t *testing.T) {
		defer setShortUploadRetryDelayForTest(0)()
		defer setUploadRetryDelayForTest(0)()
		measured := recordMeasuredForTest(t)
		f := newFakeStat()
		f.install(t)
		root, files := filesUnderCommonRoot(t, 4)
		f.set(root, true)
		provider := &dyingOnRetryProvider{
			target:   files[1].sourcePath,
			srcRoot:  root,
			attempts: map[string]int{},
			onDeath:  func() { f.set(root, false) },
		}
		liveness := newShadowRootLiveness(map[string]string{`C:`: root})
		if _, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, liveness); !errors.Is(err, errSourceSnapshotGone) {
			t.Fatalf("err = %v, want errSourceSnapshotGone", err)
		}
		for _, later := range files[2:] {
			if measured(later.sourcePath) {
				t.Fatalf("%s was admitted after the source was known to be gone", later.snapshotPath)
			}
		}
	})

	t.Run("writer still active", func(t *testing.T) {
		measured := recordMeasuredForTest(t)
		files := poolFiles(t, 5)
		provider := &stuckFenceProvider{poolProvider: newPoolProvider()}
		if _, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, nil); !errors.Is(err, errWriterStillActive) {
			t.Fatalf("err = %v, want errWriterStillActive", err)
		}
		for _, later := range files[3:] {
			if measured(later.sourcePath) {
				t.Fatalf("%s was admitted after the writer fence refused the run", later.snapshotPath)
			}
		}
	})
}
