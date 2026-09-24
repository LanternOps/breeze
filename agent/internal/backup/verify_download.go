package backup

import (
	"context"
	"errors"
	"fmt"
	"sync"
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
// holding the whole run until the command's 2 h ceiling (#6598).
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

// manifestDownloadError explains a failed manifest download. A download cut
// short by the run's own time budget is not evidence the manifest is missing,
// so it is not reported as "not found".
func manifestDownloadError(runCtx context.Context, opts VerifyOptions, err error) string {
	if errors.Is(context.Cause(runCtx), errVerifyTimeBudget) {
		return fmt.Sprintf("time budget of %s exhausted before the snapshot manifest finished downloading: %v", opts.TimeBudget.Round(time.Second), err)
	}
	return fmt.Sprintf("manifest not found: %v", err)
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
