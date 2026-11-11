package backup

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// errTestDestinationRefused is what the brokered writer answers once its store
// has refused request after request (storagesession.destinationRefusedError).
var errTestDestinationRefused = fmt.Errorf("%w: storage answered status 403 (AccessDenied)", providers.ErrDestinationRefused)

// errTestSessionGone is what the brokered writer answers once its session died.
var errTestSessionGone = fmt.Errorf("%w: session deadline has passed", providers.ErrStorageSessionUnavailable)

// attemptCounter counts upload attempts per file key.
type attemptCounter struct {
	mu       sync.Mutex
	attempts map[string]int
}

func (c *attemptCounter) note(remotePath string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.attempts == nil {
		c.attempts = map[string]int{}
	}
	c.attempts[remotePath]++
	return c.attempts[remotePath]
}

func (c *attemptCounter) max() (maxAttempts, files int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, n := range c.attempts {
		maxAttempts = max(maxAttempts, n)
	}
	return maxAttempts, len(c.attempts)
}

// A destination that refuses every request ends the run with that one error:
// the failing file is not retried, and no later file is started.
func TestDestinationRefusedEndsTheRun(t *testing.T) {
	defer setUploadConcurrencyForTest(1)()
	fastUploadRetries(t)
	measured := recordMeasuredForTest(t)
	files := poolFiles(t, 6)
	var counter attemptCounter
	provider := newPoolProvider()
	provider.hold = func(ctx context.Context, remotePath string) error {
		counter.note(remotePath)
		return errTestDestinationRefused
	}
	snapshot, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, nil)
	if !errors.Is(err, providers.ErrDestinationRefused) {
		t.Fatalf("err = %v, want the destination error", err)
	}
	if got, want := err.Error(), "backup destination refused every request: storage answered status 403 (AccessDenied)"; got != want {
		t.Fatalf("err = %q, want exactly %q", got, want)
	}
	if snapshot != nil {
		t.Fatal("a run the destination refused returned a snapshot")
	}
	if attempts, started := counter.max(); attempts != 1 || started != 1 {
		t.Fatalf("attempts per file = %d over %d files, want 1 attempt of 1 file", attempts, started)
	}
	for _, later := range files[2:] {
		if measured(later.sourcePath) {
			t.Fatalf("%s was admitted after the destination refused the run", later.snapshotPath)
		}
	}
}

// A storage session that dies mid-run ends the run at once instead of
// skipping every remaining file.
func TestStorageSessionLostMidRunEndsTheRun(t *testing.T) {
	defer setUploadConcurrencyForTest(1)()
	fastUploadRetries(t)
	measured := recordMeasuredForTest(t)
	files := poolFiles(t, 8)
	var counter attemptCounter
	provider := newPoolProvider()
	provider.hold = func(ctx context.Context, remotePath string) error {
		counter.note(remotePath)
		if poolKeyIs(remotePath, "f00") || poolKeyIs(remotePath, "f01") || poolKeyIs(remotePath, "f02") {
			return nil
		}
		return errTestSessionGone
	}
	_, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, nil)
	if !errors.Is(err, providers.ErrStorageSessionUnavailable) {
		t.Fatalf("err = %v, want the session error", err)
	}
	if got, want := err.Error(), "storage session: session is no longer usable: session deadline has passed"; got != want {
		t.Fatalf("err = %q, want exactly %q", got, want)
	}
	if attempts, started := counter.max(); attempts != 1 || started != 4 {
		t.Fatalf("attempts per file = %d over %d files, want 1 attempt each of 4 files", attempts, started)
	}
	for _, later := range files[5:] {
		if measured(later.sourcePath) {
			t.Fatalf("%s was admitted after the session was lost", later.snapshotPath)
		}
	}
}

// With the pool at full width, a run-ending outcome from a later file ends
// the run without waiting out the head file's per-file retry backoff.
func TestDestinationRefusedDoesNotWaitOutTheHeadRetry(t *testing.T) {
	defer setUploadConcurrencyForTest(4)()
	defer setUploadRetryDelayForTest(time.Hour)()
	files := poolFiles(t, 12)
	provider := newPoolProvider()
	provider.hold = func(ctx context.Context, remotePath string) error {
		if poolKeyIs(remotePath, "f00") {
			// A per-object failure: the head sits in its retry backoff.
			return errors.New("storage session: storage answered status 500")
		}
		if !provider.waitForActive(1, 5*time.Second) {
			return errors.New("test setup: head never started")
		}
		return errTestDestinationRefused
	}
	done := make(chan error, 1)
	go func() {
		_, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, nil)
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, providers.ErrDestinationRefused) {
			t.Fatalf("err = %v, want the destination error", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the run waited for the head's retry backoff instead of ending")
	}
}

// A few objects refused among successes are per-file failures, as before:
// the run completes with them recorded.
func TestScatteredStoreRefusalsStillSkipFiles(t *testing.T) {
	defer setUploadConcurrencyForTest(4)()
	fastUploadRetries(t)
	files := poolFiles(t, 12)
	provider := newPoolProvider()
	provider.hold = func(ctx context.Context, remotePath string) error {
		if poolKeyIs(remotePath, "f03") || poolKeyIs(remotePath, "f07") {
			return errors.New("storage session: storage answered status 404 (NoSuchKey)")
		}
		return nil
	}
	snapshot, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("err = %v, want a completed run", err)
	}
	if got := len(snapshot.UploadFailures); got != 2 {
		t.Fatalf("upload failures = %d, want 2", got)
	}
	if got := len(snapshot.Files); got != 10 {
		t.Fatalf("files = %d, want 10", got)
	}
}

// The read-back pass of a continued snapshot stops at the first run-ending
// answer instead of reading back (and failing) every journaled object.
func TestResumeReadBackEndsTheRunWhenTheDestinationRefuses(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		is   error
	}{
		{"destination refused", errTestDestinationRefused, providers.ErrDestinationRefused},
		{"session lost", errTestSessionGone, providers.ErrStorageSessionUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fastUploadRetries(t)
			src := t.TempDir()
			a := settledFile(t, src, "a.txt", "alpha")
			b := settledFile(t, src, "b.txt", "bravo")
			c := settledFile(t, src, "c.txt", "charlie")
			staging := t.TempDir()
			ea := journaledEntry(t, a, brokeredJournalID, "alpha")
			eb := journaledEntry(t, b, brokeredJournalID, "bravo")
			ec := journaledEntry(t, c, brokeredJournalID, "charlie")
			backing := continuingIssuer(map[string]string{ea.BackupPath: "alpha", eb.BackupPath: "bravo", ec.BackupPath: "charlie"})
			identity := backupIdentity(backing, []string{src})
			seedVerifiedJournal(t, staging, identity, brokeredJournalID, brokeredOtherJob,
				journalEntryLine{SnapshotFile: ea}, journalEntryLine{SnapshotFile: eb}, journalEntryLine{SnapshotFile: ec})
			p := &failingDigester{fakeIssuer: backing, failAfter: 0, err: tc.err}
			job, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)
			if !errors.Is(err, tc.is) {
				t.Fatalf("err = %v, want %v", err, tc.is)
			}
			if job == nil || job.Status != jobStatusFailed {
				t.Fatalf("job = %+v, want failed", job)
			}
			if p.calls != 1 {
				t.Fatalf("read-backs = %d, want 1 (the pass stops at the first run-ending answer)", p.calls)
			}
			for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
				if uploadedSource(backing, name) {
					t.Fatalf("%s was uploaded after the destination refused the run", name)
				}
			}
		})
	}
}
