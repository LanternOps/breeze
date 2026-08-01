package backup

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"sync"
	"syscall"
	"testing"
	"time"
)

// fixedErrorProvider fails every UploadContext call for the paths in failFor
// (or for every path when failFor is nil) with a caller-supplied error, and
// counts the attempts per source path. It models the shape of the field
// failures in #2997: the same error every time, so the retry cannot help.
type fixedErrorProvider struct {
	mu      sync.Mutex
	err     error
	failFor map[string]bool
	calls   map[string]int
}

func newFixedErrorProvider(err error, failFor ...string) *fixedErrorProvider {
	p := &fixedErrorProvider{err: err, calls: map[string]int{}}
	if len(failFor) > 0 {
		p.failFor = map[string]bool{}
		for _, path := range failFor {
			p.failFor[path] = true
		}
	}
	return p
}

func (p *fixedErrorProvider) UploadContext(_ context.Context, localPath, _ string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls[localPath]++
	if p.failFor == nil || p.failFor[localPath] {
		return p.err
	}
	return nil
}

func (p *fixedErrorProvider) Upload(localPath, remotePath string) error {
	return p.UploadContext(context.Background(), localPath, remotePath)
}

func (p *fixedErrorProvider) Download(string, string) error { return nil }
func (p *fixedErrorProvider) List(string) ([]string, error) { return nil, nil }
func (p *fixedErrorProvider) Delete(string) error           { return nil }

func (p *fixedErrorProvider) callCount(localPath string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls[localPath]
}

// notFoundErr is the shape a vanished source file produces on every platform:
// a *fs.PathError wrapping ENOENT (ERROR_FILE_NOT_FOUND on Windows), wrapped
// again by the compression layer exactly as CompressFile does.
func notFoundErr(path string) error {
	return fmt.Errorf("failed to open source file: %w", &fs.PathError{Op: "open", Path: path, Err: syscall.ENOENT})
}

// A permanent per-file error must skip immediately. The whole point of #2997:
// a real 123,600-file C:\Users run spent 2h38m of its 2h41m asleep in this
// backoff for 316 files that could never have succeeded.
func TestPerFileUploadRetry_PermanentError_SkipsWithoutBackoff(t *testing.T) {
	restore := setUploadRetryDelayForTest(30 * time.Second) // the real production delay
	defer restore()

	src := writeTempFile(t, "a")
	p := newFixedErrorProvider(notFoundErr(src))
	files := []backupFile{{sourcePath: src, snapshotPath: "a", size: 1}}

	start := time.Now()
	_, err := CreateSnapshotContext(context.Background(), p, files)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("want an error when the only file fails permanently, got nil")
	}
	if elapsed >= 5*time.Second {
		t.Fatalf("permanent error slept in the retry backoff: elapsed %s (retry delay is 30s)", elapsed)
	}
	if got := p.callCount(src); got != 1 {
		t.Fatalf("want exactly 1 upload attempt for a permanent error (no retry), got %d", got)
	}
}

// The 30s retry must survive for genuinely transient failures — the two S3
// UploadPart/PutObject errors in the same field log SHOULD still be retried.
func TestPerFileUploadRetry_TransientError_StillWaitsAndRetries(t *testing.T) {
	const delay = 200 * time.Millisecond
	restore := setUploadRetryDelayForTest(delay)
	defer restore()

	src := writeTempFile(t, "a")
	p := newFixedErrorProvider(errors.New("UploadPart: RequestTimeout: your socket connection timed out"))
	files := []backupFile{{sourcePath: src, snapshotPath: "a", size: 1}}

	start := time.Now()
	_, err := CreateSnapshotContext(context.Background(), p, files)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("want an error when the only file fails twice, got nil")
	}
	if elapsed < delay {
		t.Fatalf("transient error did not wait out the retry backoff: elapsed %s, want >= %s", elapsed, delay)
	}
	if got := p.callCount(src); got != 2 {
		t.Fatalf("want exactly 2 upload attempts for a transient error (initial + one retry), got %d", got)
	}
}

// Skipping without the backoff must not change what the run reports: the file
// is still dropped from the snapshot, still counted in UploadFailures (which
// becomes job.ErrorCount), and must NOT abort the job.
func TestPerFileUploadRetry_PermanentError_StillCountedAndJobContinues(t *testing.T) {
	restore := setUploadRetryDelayForTest(30 * time.Second)
	defer restore()

	good := writeTempFile(t, "good")
	bad := writeTempFile(t, "bad")
	p := newFixedErrorProvider(notFoundErr(bad), bad)
	files := []backupFile{
		{sourcePath: good, snapshotPath: "good", size: 4},
		{sourcePath: bad, snapshotPath: "bad", size: 3},
	}

	start := time.Now()
	snap, err := CreateSnapshotContext(context.Background(), p, files)
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("a permanent per-file failure must not abort the job, got %v", err)
	}
	if snap == nil {
		t.Fatal("want a snapshot for a partial-success run, got nil")
	}
	if len(snap.Files) != 1 {
		t.Fatalf("want 1 uploaded file, got %d", len(snap.Files))
	}
	if len(snap.UploadFailures) != 1 {
		t.Fatalf("want the skipped file counted in UploadFailures, got %d", len(snap.UploadFailures))
	}
	if elapsed >= 5*time.Second {
		t.Fatalf("permanent error slept in the retry backoff: elapsed %s", elapsed)
	}
	if got := p.callCount(bad); got != 1 {
		t.Fatalf("want exactly 1 upload attempt for the permanently-failing file, got %d", got)
	}
}

func TestClassifyPermanentUploadError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{name: "nil", err: nil, want: false},
		{name: "job cancel is never permanent", err: errBackupStopped, want: false},
		{name: "wrapped job cancel is never permanent", err: fmt.Errorf("upload: %w", errBackupStopped), want: false},
		{name: "context canceled is never permanent", err: context.Canceled, want: false},
		{name: "deadline exceeded is never permanent", err: context.DeadlineExceeded, want: false},
		{name: "generic transient upload error", err: errors.New("UploadPart: RequestTimeout"), want: false},
		{name: "connection reset is transient", err: syscall.ECONNRESET, want: false},
		{name: "vanished source file", err: notFoundErr("C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Cache\\f_00a1"), want: true},
		{
			name: "vanished source file surfaced by the compression layer",
			err:  fmt.Errorf("failed to compress file: %w", &fs.PathError{Op: "read", Path: "x", Err: syscall.ENOENT}),
			want: true,
		},
		{name: "bare fs.ErrNotExist", err: fs.ErrNotExist, want: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, got := classifyPermanentUploadError(tc.err)
			if got != tc.want {
				t.Fatalf("classifyPermanentUploadError(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// The Win32 code table is declared platform-independently precisely so it can
// be asserted here, on any OS. See upload_error_class_other.go for why the
// table must never be applied to a Unix errno.
func TestLookupPermanentWindowsErrno(t *testing.T) {
	tests := []struct {
		name     string
		code     uintptr
		wantName string
		want     bool
	}{
		{name: "sharing violation (live browser cache)", code: 32, wantName: "ERROR_SHARING_VIOLATION", want: true},
		{name: "lock violation", code: 33, wantName: "ERROR_LOCK_VIOLATION", want: true},
		{name: "file not found", code: 2, wantName: "ERROR_FILE_NOT_FOUND", want: true},
		{name: "path not found", code: 3, wantName: "ERROR_PATH_NOT_FOUND", want: true},
		{name: "cloud file access denied (OneDrive placeholder)", code: 0x17C, wantName: "ERROR_CLOUD_FILE_ACCESS_DENIED", want: true},
		{name: "success is not a failure", code: 0, want: false},
		{name: "plain access denied stays retryable", code: 5, want: false},
		{name: "network name deleted stays retryable", code: 64, want: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			name, ok := lookupPermanentWindowsErrno(tc.code)
			if ok != tc.want {
				t.Fatalf("lookupPermanentWindowsErrno(%d) ok = %v, want %v", tc.code, ok, tc.want)
			}
			if ok && name != tc.wantName {
				t.Fatalf("lookupPermanentWindowsErrno(%d) name = %q, want %q", tc.code, name, tc.wantName)
			}
		})
	}
}
