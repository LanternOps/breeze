package backup

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// midFileProvider reports a partial offset through the upload-progress
// callback on ctx (as a real provider does while it reads the source), then
// blocks until release — a single large file caught mid-transfer.
type midFileProvider struct {
	partial int64
	reached chan struct{}
	release chan struct{}
	once    sync.Once
}

func (p *midFileProvider) Upload(localPath, remotePath string) error {
	return p.UploadContext(context.Background(), localPath, remotePath)
}

func (p *midFileProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	if fn := providers.UploadProgressFunc(ctx); fn != nil {
		fn(p.partial)
	}
	p.once.Do(func() { close(p.reached) })
	select {
	case <-p.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *midFileProvider) Download(remotePath, localPath string) error { return nil }
func (p *midFileProvider) List(prefix string) ([]string, error)        { return nil, nil }
func (p *midFileProvider) Delete(remotePath string) error              { return nil }

// #5417: during one large file's upload, bytesDone must advance with the
// bytes read so far — not sit at its pre-upload value until the file
// completes. The keepalive interval is set far beyond the test's lifetime so
// only an in-file progress emission can satisfy the assertion.
func TestSnapshotProgress_ReportsBytesWithinSingleFileUpload(t *testing.T) {
	defer setProgressThrottleForTest(0)()
	defer setProgressKeepaliveIntervalForTest(time.Hour)()

	content := "0123456789" // 10 bytes on disk and in the walk
	provider := &midFileProvider{partial: 4, reached: make(chan struct{}), release: make(chan struct{})}
	files := []backupFile{{sourcePath: writeTempFile(t, content), snapshotPath: "a", size: 10, modTime: time.Now()}}

	var mu sync.Mutex
	var seen []int64
	midFile := make(chan int64, 16)
	done := make(chan error, 1)
	go func() {
		_, err := createSnapshotWithProgress(context.Background(), provider, files,
			func(fd, ft int, bd, bt int64, _ string) {
				mu.Lock()
				seen = append(seen, bd)
				mu.Unlock()
				if fd == 0 && bd > 0 {
					select {
					case midFile <- bd:
					default:
					}
				}
			}, nil, nil, nil)
		done <- err
	}()

	select {
	case got := <-midFile:
		if got != 4 {
			t.Fatalf("mid-file bytesDone = %d, want the 4 bytes read so far", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no progress emission carried in-file bytes while the single upload was in flight")
	}

	close(provider.release)
	if err := <-done; err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if last := seen[len(seen)-1]; last != 10 {
		t.Fatalf("final bytesDone = %d, want 10 (no double count of in-file bytes)", last)
	}
}

// failAfterPartialProvider reads part of the FIRST file and then fails it
// (every attempt); later files succeed after reporting their own offsets.
// Emission is asynchronous (the snapshot's progress goroutine emits on a
// kick), so the failing attempt waits until the partial has been observed —
// modelling a large file that fails long after its bytes were reported.
type failAfterPartialProvider struct {
	failPath string
	observed chan struct{}
}

func (p *failAfterPartialProvider) Upload(localPath, remotePath string) error {
	return p.UploadContext(context.Background(), localPath, remotePath)
}

func (p *failAfterPartialProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	fn := providers.UploadProgressFunc(ctx)
	if localPath == p.failPath {
		if fn != nil {
			fn(60)
		}
		select {
		case <-p.observed:
		case <-time.After(5 * time.Second):
		}
		return errors.New("destination reset the connection")
	}
	if fn != nil {
		fn(5)
		// A late or oversized offset (SDK read-ahead past a file that
		// shrank since the walk) must be capped at the walk-time size.
		fn(1 << 20)
	}
	return nil
}

func (p *failAfterPartialProvider) Download(remotePath, localPath string) error { return nil }
func (p *failAfterPartialProvider) List(prefix string) ([]string, error)        { return nil, nil }
func (p *failAfterPartialProvider) Delete(remotePath string) error              { return nil }

// The reported counters must never go backwards (see startRunKeepalive): a
// file that fails after part of it was reported must not make bytesDone
// drop, and an in-file offset may never exceed the file's own size.
func TestSnapshotProgress_InFileBytesNeverGoBackwardsOrOvercount(t *testing.T) {
	defer setProgressThrottleForTest(0)()
	defer setProgressKeepaliveIntervalForTest(time.Hour)()
	defer setUploadRetryDelayForTest(0)()

	bad := writeTempFile(t, string(make([]byte, 100)))
	good := writeTempFile(t, "0123456789")
	files := []backupFile{
		{sourcePath: bad, snapshotPath: "bad", size: 100, modTime: time.Now()},
		{sourcePath: good, snapshotPath: "good", size: 10, modTime: time.Now()},
	}

	var mu sync.Mutex
	var seen []int64
	observed := make(chan struct{})
	var observedOnce sync.Once
	_, _ = createSnapshotWithProgress(context.Background(), &failAfterPartialProvider{failPath: bad, observed: observed}, files,
		func(_, _ int, bd, bt int64, _ string) {
			mu.Lock()
			seen = append(seen, bd)
			mu.Unlock()
			if bd == 60 {
				observedOnce.Do(func() { close(observed) })
			}
		}, nil, nil, nil)

	mu.Lock()
	defer mu.Unlock()
	var sawPartial bool
	for i, bd := range seen {
		if i > 0 && bd < seen[i-1] {
			t.Fatalf("bytesDone went backwards: %v", seen)
		}
		if bd > 110 {
			t.Fatalf("bytesDone %d exceeds bytesTotal 110: %v", bd, seen)
		}
		if bd == 60 {
			sawPartial = true
		}
	}
	if !sawPartial {
		t.Fatalf("the failed file's in-flight 60 bytes were never reported: %v", seen)
	}
}
