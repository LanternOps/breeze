package backup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// VerifyOptions tunes a VerifyIntegrity or TestRestore run. The zero value
// is valid: no progress callback and no time budget.
type VerifyOptions struct {
	// Progress, when set, is called on the caller's goroutine each time a
	// manifest entry finishes (verified, failed or skipped as content-less).
	// done counts finished entries; total is the number of manifest entries.
	// Downloads run concurrently, so entries finish out of manifest order, but
	// done always increases by one per call.
	Progress func(done, total int)

	// TimeBudget, when positive, bounds the whole run. When it elapses the
	// run stops starting files, cancels the downloads in flight, and returns
	// the counts gathered so far as a NON-error result: Status is partial (or
	// failed when nothing verified), FilesUnchecked says how many files were
	// never verified, and Error explains why. Without it a run that outlives
	// the command's deadline is discarded whole, and the server shows
	// "0 files ok 0 files failed" after hours of work (#6598).
	//
	// A cancellation of the caller's ctx (backup_stop) is still returned as
	// an error, exactly as before; only the run's own budget is converted.
	TimeBudget time.Duration
}

// errVerifyTimeBudget is the cancellation cause attached to a run context
// whose VerifyOptions.TimeBudget elapsed.
var errVerifyTimeBudget = errors.New("verification time budget exhausted")

// runContext derives the context a verify/test-restore run works under.
func (o VerifyOptions) runContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if o.TimeBudget > 0 {
		return context.WithTimeoutCause(ctx, o.TimeBudget, errVerifyTimeBudget)
	}
	return context.WithCancel(ctx)
}

// verifyDownloadConcurrency is how many objects a verify or test-restore run
// downloads at once. Object-store round trips, not bandwidth, dominate a
// snapshot of many small files: at ~200k objects even 40 ms per GET is over
// two hours serially (#6598). Eight stays below the AWS SDK transport's
// default of 10 idle connections per host, so the S3 client reuses
// connections instead of churning TLS handshakes.
var verifyDownloadConcurrency = 8

// setVerifyConcurrencyForTest overrides verifyDownloadConcurrency. Call the
// returned func (typically via defer) to restore it.
func setVerifyConcurrencyForTest(n int) (restore func()) {
	old := verifyDownloadConcurrency
	verifyDownloadConcurrency = n
	return func() { verifyDownloadConcurrency = old }
}

// downloadMinThroughputBps and downloadTimeoutFloor size the per-file
// download deadline the same way uploadDeadline sizes uploads: assume at
// least 64 KiB/s, never less than the floor. A transfer that exceeds it is a
// stall — that FILE fails and the run moves on, instead of one hung object
// holding the whole run until the command's 2 h ceiling (#6598). The floor
// is also the no-progress window for downloads whose size is not known in
// advance (downloadWithStallTimeout), which get no total deadline.
const downloadMinThroughputBps = 64 * 1024

var downloadTimeoutFloor = 5 * time.Minute

// setDownloadTimeoutFloorForTest overrides downloadTimeoutFloor. Call the
// returned func (typically via defer) to restore it.
func setDownloadTimeoutFloorForTest(d time.Duration) (restore func()) {
	old := downloadTimeoutFloor
	downloadTimeoutFloor = d
	return func() { downloadTimeoutFloor = old }
}

// downloadDeadline returns the per-file download deadline for an object whose
// manifest size is size. For a .gz object size is the uncompressed length,
// which only makes the deadline more generous.
func downloadDeadline(size int64) time.Duration {
	d := time.Duration(size/downloadMinThroughputBps) * time.Second
	if d < downloadTimeoutFloor {
		return downloadTimeoutFloor
	}
	return d
}

// downloadWithDeadline downloads remotePath to localPath, bounded by ctx and
// by a per-file deadline. Providers that implement
// providers.ContextDownloader (every production provider) are cancelled
// mid-transfer; a provider without it (test fakes) gets the plain,
// uncancellable Download.
//
// A per-file deadline expiry is reported as a stall naming the deadline. A
// cancellation of ctx itself is returned unwrapped from the provider, and
// callers must check ctx.Err() to tell the two apart.
func downloadWithDeadline(ctx context.Context, provider providers.BackupProvider, remotePath, localPath string, deadline time.Duration) error {
	d, ok := provider.(providers.ContextDownloader)
	if !ok {
		return provider.Download(remotePath, localPath)
	}
	fileCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	err := d.DownloadContext(fileCtx, remotePath, localPath)
	if err != nil && ctx.Err() == nil && fileCtx.Err() != nil {
		return fmt.Errorf("download stalled: no completion within the %s per-file deadline: %w", deadline, err)
	}
	return err
}

// errDownloadStalled is matched (errors.Is) by a downloadStallError.
var errDownloadStalled = errors.New("download stalled")

// downloadStallError reports a download cancelled because no bytes arrived
// for a whole no-progress window.
type downloadStallError struct {
	window   time.Duration
	received int64
	err      error
}

func (e *downloadStallError) Error() string {
	return fmt.Sprintf("download stalled: no data received for %s (%d bytes received before it stopped): %v", e.window, e.received, e.err)
}

func (e *downloadStallError) Unwrap() []error { return []error{errDownloadStalled, e.err} }

// downloadStallWindow is how long a download whose size is not known in
// advance may go without receiving a byte before it is cancelled as stalled.
// It is the per-file deadline floor: the least time any single transfer is
// ever given.
func downloadStallWindow() time.Duration { return downloadTimeoutFloor }

// downloadWithStallTimeout downloads remotePath to localPath, bounded by ctx
// and by a NO-PROGRESS window instead of a total deadline. It is for objects
// whose size is not known before they download, the snapshot manifest in
// particular: a fixed total deadline there fails a large manifest on a slow
// link that is still delivering (a 46 MiB manifest at 100 KB/s failed every
// run at exactly 5 m, #6929), while a genuine stall must still end in bounded
// time. The transfer is cancelled only when no byte has arrived for
// downloadStallWindow().
//
// Progress comes from the provider's WithDownloadProgress callback (every
// production provider reports it), backed up by localPath growing past the
// largest size seen so far, so a
// provider that writes the destination without reporting is still seen as
// progressing. Once the provider has reported any progress through the
// callback, the callback is authoritative (WithDownloadProgress requires it
// to report every chunk) and file growth is ignored: the callback stamped
// those bytes when they arrived, and re-crediting them when the growth was
// sampled, a window later, made a stall take about two windows to detect
// (#6952). Destination size is not a byte count anyway: a ranged parallel
// writer (Azure) can extend it past what has arrived. A provider that never
// reports is seen through growth alone, sampled only when the window is
// about to expire and credited at the sample time, so it fails at most two
// windows after its last byte and is never cut off early.
// A provider without providers.ContextDownloader (test fakes)
// gets the plain, uncancellable Download, as in downloadWithDeadline.
//
// A stall is returned as a *downloadStallError (errors.Is errDownloadStalled).
// A cancellation of ctx itself is returned unwrapped from the provider, and
// callers must check ctx.Err() to tell the two apart.
func downloadWithStallTimeout(ctx context.Context, provider providers.BackupProvider, remotePath, localPath string) error {
	d, ok := provider.(providers.ContextDownloader)
	if !ok {
		return provider.Download(remotePath, localPath)
	}
	window := downloadStallWindow()

	var received atomic.Int64
	var lastProgress atomic.Int64 // UnixNano of the last observed progress
	lastProgress.Store(time.Now().UnixNano())

	fileCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	fileCtx = providers.WithDownloadProgress(fileCtx, func(n int64) {
		received.Add(n)
		advanceProgress(&lastProgress, time.Now().UnixNano())
	})

	done := make(chan struct{})
	watcherDone := make(chan struct{})
	go func() {
		defer close(watcherDone)
		// Only growth past the largest size seen is progress: a file that
		// shrinks (re-created by a retry or by FallbackProvider's next
		// candidate) and regrows to an old size delivered no new data.
		maxSize := max(localFileSize(localPath), 0)
		timer := time.NewTimer(window)
		defer timer.Stop()
		for {
			select {
			case <-done:
				return
			case <-fileCtx.Done():
				return
			case <-timer.C:
			}
			now := time.Now()
			if size := localFileSize(localPath); size > maxSize {
				maxSize = size
				// A reporting provider's bytes were stamped by the callback
				// when they landed; crediting growth again now would extend
				// the deadline by up to a window past the last byte (#6952).
				if received.Load() == 0 {
					advanceProgress(&lastProgress, now.UnixNano())
				}
			}
			idle := now.Sub(time.Unix(0, lastProgress.Load()))
			if idle >= window {
				cancel(errDownloadStalled)
				return
			}
			timer.Reset(window - idle)
		}
	}()

	err := d.DownloadContext(fileCtx, remotePath, localPath)
	close(done)
	<-watcherDone
	if err != nil && ctx.Err() == nil && errors.Is(context.Cause(fileCtx), errDownloadStalled) {
		got := received.Load()
		if size := localFileSize(localPath); size > got {
			got = size
		}
		return &downloadStallError{window: window, received: got, err: err}
	}
	return err
}

// advanceProgress moves *last forward to at, never backward. The progress
// callback (possibly from several goroutines) and the file-growth sampler
// both record progress, and a writer descheduled between reading the clock
// and storing must not overwrite a later timestamp with its older one.
func advanceProgress(last *atomic.Int64, at int64) {
	for {
		cur := last.Load()
		if at <= cur || last.CompareAndSwap(cur, at) {
			return
		}
	}
}

// localFileSize returns the size of path, or -1 when it cannot be stat'ed.
func localFileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return -1
	}
	return info.Size()
}

// runFileChecks calls check(i) for every i in [0, n) on up to
// verifyDownloadConcurrency goroutines and onDone(i) on the CALLER's
// goroutine as each finishes, so onDone needs no locking. Once ctx is done
// no further check is started; checks already running are expected to
// observe ctx themselves. It returns only after every started check has
// returned, so callers may clean up shared state (the restore directory)
// immediately afterwards.
func runFileChecks(ctx context.Context, n int, check func(i int), onDone func(i int)) {
	workers := verifyDownloadConcurrency
	if workers < 1 {
		workers = 1
	}
	if workers > n {
		workers = n
	}
	if workers == 0 {
		return
	}

	jobs := make(chan int)
	finished := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				// The dispatcher's select can hand out an index in the same
				// instant ctx ends; never start work after cancellation.
				if ctx.Err() != nil {
					continue
				}
				check(i)
				finished <- i
			}
		}()
	}
	go func() {
		defer close(jobs)
		for i := 0; i < n; i++ {
			if ctx.Err() != nil {
				return
			}
			select {
			case <-ctx.Done():
				return
			case jobs <- i:
			}
		}
	}()
	go func() {
		wg.Wait()
		close(finished)
	}()
	for i := range finished {
		if onDone != nil {
			onDone(i)
		}
	}
}

// fileCheckState is the outcome of checking one manifest entry.
type fileCheckState int

const (
	// fileNotChecked: never started, or interrupted by the run ending. Only
	// counted as unchecked for entries that have content to check.
	fileNotChecked fileCheckState = iota
	fileSkipped                   // content-less entry, nothing to download
	fileVerified
	fileFailed
)

type fileCheckOutcome struct {
	state    fileCheckState
	size     int64
	sizeOnly bool
	warnings []string
}

// countUnchecked returns how many content-bearing entries never reached a
// verdict.
func countUnchecked(files []SnapshotFile, outcomes []fileCheckOutcome) int {
	n := 0
	for i, o := range outcomes {
		if o.state == fileNotChecked && files[i].HasContent() {
			n++
		}
	}
	return n
}

// countContentFiles returns how many manifest entries have an object to check.
func countContentFiles(files []SnapshotFile) int {
	n := 0
	for _, f := range files {
		if f.HasContent() {
			n++
		}
	}
	return n
}

// manifestDownloadError explains a failed manifest download. Only a provider
// that positively reports the object missing makes it "not found": a download
// cut short by the run's time budget or by a stall, or any other transport
// error, is not evidence the manifest is missing (#6929).
func manifestDownloadError(runCtx context.Context, opts VerifyOptions, err error) string {
	var stall *downloadStallError
	switch {
	case errors.Is(context.Cause(runCtx), errVerifyTimeBudget):
		return fmt.Sprintf("time budget of %s exhausted before the snapshot manifest finished downloading: %v", opts.TimeBudget.Round(time.Second), err)
	case errors.As(err, &stall):
		return fmt.Sprintf("snapshot manifest download stalled: no data received for %s (%d bytes received before it stopped): %v", stall.window, stall.received, stall.err)
	case errors.Is(err, providers.ErrObjectNotFound):
		// Not fs.ErrNotExist: a destination-side ENOENT (the temp dir
		// vanished) must never read as "the object is missing". Providers
		// map a missing SOURCE to ErrObjectNotFound (see LocalProvider).
		return fmt.Sprintf("manifest not found: %v", err)
	default:
		return fmt.Sprintf("failed to download snapshot manifest: %v", err)
	}
}

// logInterruptedDownload records the provider error of a download that was
// cut short by the run ending, so a real failure that coincided with the
// cancellation still leaves a trace (the file itself is counted unchecked).
func logInterruptedDownload(phase, backupPath string, dlErr error) {
	if dlErr == nil {
		return
	}
	log.Debug("download interrupted by the run ending; file left unchecked", "phase", phase,
		"backupPath", backupPath, "error", dlErr.Error())
}

// timeBudgetMessage explains a run that stopped at its time budget.
func timeBudgetMessage(kind string, budget time.Duration, verified, failed, contentFiles int) string {
	return fmt.Sprintf("%s time budget of %s exhausted: checked %d of %d files (%d ok, %d failed); the remaining %d were not verified",
		kind, budget.Round(time.Second), verified+failed, contentFiles, verified, failed, contentFiles-verified-failed)
}
