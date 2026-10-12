package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// poolProvider is a mockProvider whose file uploads (keys under files/) go
// through hold while counted as active, so a test can observe and steer how
// many uploads are in flight at once. Control objects (manifest, lease) pass
// straight through.
type poolProvider struct {
	*mockProvider
	hold func(ctx context.Context, remotePath string) error
	// ignoresCancel stores the object even when ctx was cancelled during
	// hold, like a provider with no cancellation hook finishing its PUT.
	ignoresCancel bool

	mu                sync.Mutex
	active, peak      int
	started           int
	startedAfterClose int
	closed            bool
	activeAtManifest  int
	manifestUploads   int
}

func newPoolProvider() *poolProvider { return &poolProvider{mockProvider: newMockProvider()} }

func isFileObject(remotePath string) bool {
	return strings.Contains(remotePath, "/"+snapshotFilesDir+"/")
}

func (p *poolProvider) Upload(localPath, remotePath string) error {
	return p.UploadContext(context.Background(), localPath, remotePath)
}

func (p *poolProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	if !isFileObject(remotePath) {
		if isManifestPath(remotePath) {
			p.mu.Lock()
			p.manifestUploads++
			p.activeAtManifest = p.active
			p.mu.Unlock()
		}
		return p.mockProvider.Upload(localPath, remotePath)
	}
	p.mu.Lock()
	p.active++
	p.started++
	if p.active > p.peak {
		p.peak = p.active
	}
	if p.closed {
		p.startedAfterClose++
	}
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.active--
		p.mu.Unlock()
	}()
	if p.hold != nil {
		if err := p.hold(ctx, remotePath); err != nil {
			return err
		}
	}
	if err := ctx.Err(); err != nil && !p.ignoresCancel {
		return err
	}
	return p.mockProvider.Upload(localPath, remotePath)
}

func (p *poolProvider) snapshotStats() (active, peak, started int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.active, p.peak, p.started
}

// close marks the run as returned: any upload starting after this is a
// worker that outlived createSnapshotWithProgress.
func (p *poolProvider) close() {
	p.mu.Lock()
	p.closed = true
	p.mu.Unlock()
}

// waitForActive blocks until at least n file uploads are in flight, or
// timeout passes. It reports whether n was reached.
func (p *poolProvider) waitForActive(n int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if active, _, _ := p.snapshotStats(); active >= n {
			return true
		}
		time.Sleep(time.Millisecond)
	}
	return false
}

// poolFiles writes n distinct files and returns them in walk order.
func poolFiles(t *testing.T, n int) []backupFile {
	t.Helper()
	dir := t.TempDir()
	files := make([]backupFile, 0, n)
	for i := 0; i < n; i++ {
		content := fmt.Sprintf("file %02d %s", i, strings.Repeat("x", i))
		p := filepath.Join(dir, fmt.Sprintf("f%02d.txt", i))
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		files = append(files, backupFile{sourcePath: p, snapshotPath: fmt.Sprintf("dir/f%02d.txt", i), size: int64(len(content)), modTime: time.Unix(1700000000, 0)})
	}
	return files
}

// (a) With concurrency > 1 the file pass really has several uploads in
// flight at once: each upload waits for its peers, which a serial loop can
// never satisfy.
func TestUploadPool_OverlapsFileUploads(t *testing.T) {
	defer setUploadConcurrencyForTest(4)()
	provider := newPoolProvider()
	provider.hold = func(ctx context.Context, _ string) error {
		provider.waitForActive(4, 300*time.Millisecond)
		return nil
	}
	files := poolFiles(t, 8)

	snapshot, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if _, peak, _ := provider.snapshotStats(); peak < 4 {
		t.Fatalf("peak concurrent uploads = %d, want 4", peak)
	}
	if len(snapshot.Files) != len(files) {
		t.Fatalf("manifest has %d files, want %d", len(snapshot.Files), len(files))
	}
}

// A single worker keeps the old serial behaviour exactly.
func TestUploadPool_ConcurrencyOneIsSerial(t *testing.T) {
	defer setUploadConcurrencyForTest(1)()
	provider := newPoolProvider()
	files := poolFiles(t, 6)
	if _, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, nil); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if _, peak, _ := provider.snapshotStats(); peak != 1 {
		t.Fatalf("peak concurrent uploads = %d with one worker, want 1", peak)
	}
}

// poolRun is what a differential run produced, normalized so runs at
// different concurrency compare equal when they behave the same.
type poolRun struct {
	manifest string
	failures []string
	stored   map[string]string
}

func runPoolDifferential(t *testing.T, workers int, files []backupFile, failKey string) poolRun {
	t.Helper()
	defer setUploadConcurrencyForTest(workers)()
	provider := newPoolProvider()
	// Later files finish first, so a pool that appended in completion order
	// would scramble the manifest.
	provider.hold = func(ctx context.Context, remotePath string) error {
		var idx int
		_, _ = fmt.Sscanf(filepath.Base(remotePath), "f%02d", &idx)
		select {
		case <-time.After(time.Duration(len(files)-idx) * 2 * time.Millisecond):
		case <-ctx.Done():
			return ctx.Err()
		}
		if failKey != "" && strings.Contains(remotePath, failKey) {
			return errors.New("destination refused the object")
		}
		return nil
	}
	snapshot, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("snapshot with %d workers: %v", workers, err)
	}
	snapshot.ID = "normalized"
	snapshot.Timestamp = time.Time{}
	var normalized []SnapshotFile
	for _, f := range snapshot.Files {
		f.BackupPath = strings.TrimPrefix(f.BackupPath, path0(f.BackupPath))
		normalized = append(normalized, f)
	}
	snapshot.Files = normalized
	snapshot.PublishedObjects = nil
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	run := poolRun{manifest: string(raw), stored: map[string]string{}}
	for _, e := range snapshot.UploadFailures {
		run.failures = append(run.failures, e.Error())
	}
	provider.mockProvider.mu.Lock()
	for k, v := range provider.mockProvider.files {
		if isFileObject(k) {
			run.stored[strings.TrimPrefix(k, path0(k))] = string(v)
		}
	}
	provider.mockProvider.mu.Unlock()
	return run
}

// path0 is the "snapshots/<id>/" prefix of a key, which differs per run.
func path0(key string) string {
	parts := strings.SplitN(key, "/", 3)
	if len(parts) < 3 {
		return ""
	}
	return parts[0] + "/" + parts[1] + "/"
}

// (b) + (d) The pool produces the same manifest (entries, order, sizes,
// checksums, keys — case twins included) and the same failures as the serial
// pass, even when uploads complete out of order and one file fails.
func TestUploadPool_ManifestAndFailuresMatchSerialPass(t *testing.T) {
	defer setUploadRetryDelayForTest(0)()
	defer setShortUploadRetryDelayForTest(0)()
	files := poolFiles(t, 12)
	// Case twins: the folded-key claim must be made in walk order, so the
	// later twin is the one that gets the disambiguated key either way.
	files[7].snapshotPath = "dir/Twin.txt"
	files[8].snapshotPath = "dir/twin.txt"

	for _, tc := range []struct {
		name    string
		failKey string
	}{
		{"all succeed", ""},
		{"one file fails", "f05"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			serial := runPoolDifferential(t, 1, files, tc.failKey)
			pooled := runPoolDifferential(t, 8, files, tc.failKey)
			if serial.manifest != pooled.manifest {
				t.Fatalf("manifest differs from the serial pass\nserial: %s\npooled: %s", serial.manifest, pooled.manifest)
			}
			if strings.Join(serial.failures, "\n") != strings.Join(pooled.failures, "\n") {
				t.Fatalf("failures differ\nserial: %q\npooled: %q", serial.failures, pooled.failures)
			}
			if len(serial.stored) != len(pooled.stored) {
				t.Fatalf("stored %d objects serially, %d pooled", len(serial.stored), len(pooled.stored))
			}
			for k, v := range serial.stored {
				if pooled.stored[k] != v {
					t.Fatalf("object %s differs between serial and pooled runs", k)
				}
			}
			if tc.failKey != "" {
				if len(pooled.failures) != 1 || !strings.HasPrefix(pooled.failures[0], "failed to upload "+files[5].sourcePath+": ") {
					t.Fatalf("failures = %q, want exactly the one failing file", pooled.failures)
				}
				if !strings.Contains(pooled.manifest, `"incompleteFiles":1`) {
					t.Fatalf("manifest does not record the missing file: %s", pooled.manifest)
				}
			}
		})
	}
}

// (c) Cancelling the job stops every worker: the run returns only after all
// in-flight uploads have returned, none starts afterwards, the journal-less
// prefix is cleaned up after (not during) the drain, and no goroutine leaks.
func TestUploadPool_CancelDrainsWorkers(t *testing.T) {
	defer setUploadConcurrencyForTest(4)()
	before := runtime.NumGoroutine()
	provider := newPoolProvider()
	// Each upload notices the cancel late and then completes its PUT anyway
	// (a provider with no cancellation hook). A run that cleaned the prefix
	// before its workers returned would leave those objects behind.
	provider.ignoresCancel = true
	provider.hold = func(ctx context.Context, _ string) error {
		<-ctx.Done()
		time.Sleep(20 * time.Millisecond)
		return nil
	}
	files := poolFiles(t, 12)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		// Cancel either way, so a serial loop fails the peak assertion
		// below instead of hanging.
		provider.waitForActive(4, 2*time.Second)
		cancel()
	}()

	_, err := createSnapshotWithProgress(ctx, provider, files, nil, nil, nil, nil)
	if !errors.Is(err, errBackupStopped) {
		t.Fatalf("err = %v, want errBackupStopped", err)
	}
	active, peak, _ := provider.snapshotStats()
	provider.close()
	if peak < 4 {
		t.Fatalf("peak concurrent uploads = %d; cancellation was not exercised with 4 uploads in flight", peak)
	}
	if active != 0 {
		t.Fatalf("run returned with %d uploads still in flight", active)
	}
	time.Sleep(50 * time.Millisecond)
	provider.mu.Lock()
	late := provider.startedAfterClose
	provider.mu.Unlock()
	if late != 0 {
		t.Fatalf("%d uploads started after the run returned", late)
	}
	provider.mockProvider.mu.Lock()
	leftover := len(provider.mockProvider.files)
	provider.mockProvider.mu.Unlock()
	if leftover != 0 {
		t.Fatalf("%d objects left in the stopped run's prefix", leftover)
	}
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > before && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if after := runtime.NumGoroutine(); after > before {
		t.Fatalf("goroutines: %d before, %d after the run returned", before, after)
	}
}

// The source-gone abort publishes its partial manifest only after every
// worker has returned, and the manifest holds exactly the files before the
// one whose failure revealed the dead source.
func TestUploadPool_SourceGoneDrainsBeforePartialPublish(t *testing.T) {
	defer setUploadConcurrencyForTest(4)()
	files := poolFiles(t, 10)
	dead := files[2].sourcePath
	provider := newPoolProvider()
	provider.hold = func(ctx context.Context, remotePath string) error {
		switch {
		case strings.Contains(remotePath, "f00"), strings.Contains(remotePath, "f01"):
			return nil
		case strings.Contains(remotePath, "f02"):
			return errors.New("source read failed")
		}
		<-ctx.Done()
		time.Sleep(20 * time.Millisecond)
		return ctx.Err()
	}
	var goneMu sync.Mutex
	gone := false
	liveness := func(p string) error {
		goneMu.Lock()
		defer goneMu.Unlock()
		if p == dead {
			gone = true
		}
		if gone {
			return errSourceSnapshotGoneForTest
		}
		return nil
	}

	snapshot, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, liveness)
	if !errors.Is(err, errSourceSnapshotGoneForTest) {
		t.Fatalf("err = %v, want the source-gone cause", err)
	}
	if snapshot == nil || len(snapshot.Files) != 2 {
		t.Fatalf("partial manifest = %+v, want the 2 files before the dead source", snapshot)
	}
	provider.mu.Lock()
	defer provider.mu.Unlock()
	if provider.manifestUploads != 1 || provider.activeAtManifest != 0 {
		t.Fatalf("manifest uploads = %d with %d file uploads still in flight; want 1 with 0", provider.manifestUploads, provider.activeAtManifest)
	}
}

var errSourceSnapshotGoneForTest = errors.New("source snapshot is gone")

// fencedPoolProvider rejects file uploads with ErrPreviousWriterActive until
// AwaitWriteAccess has been granted once.
type fencedPoolProvider struct {
	*poolProvider
	fmu        sync.Mutex
	granted    bool
	rejections int
	awaits     int
}

func (p *fencedPoolProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	if isFileObject(remotePath) {
		p.fmu.Lock()
		granted := p.granted
		if !granted {
			p.rejections++
		}
		p.fmu.Unlock()
		if !granted {
			return fmt.Errorf("storage session: %w", providers.ErrPreviousWriterActive)
		}
	}
	return p.poolProvider.UploadContext(ctx, localPath, remotePath)
}

func (p *fencedPoolProvider) Upload(localPath, remotePath string) error {
	return p.UploadContext(context.Background(), localPath, remotePath)
}

func (p *fencedPoolProvider) AwaitWriteAccess(ctx context.Context) error {
	p.fmu.Lock()
	p.awaits++
	p.fmu.Unlock()
	// Long enough for every worker's rejection to arrive while this wait
	// is in progress.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		p.fmu.Lock()
		r := p.rejections
		p.fmu.Unlock()
		if r >= 4 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	p.fmu.Lock()
	p.granted = true
	p.fmu.Unlock()
	return nil
}

// Several workers refused by the writer fence at once share ONE
// AwaitWriteAccess wait rather than each spending a control-plane call on it.
func TestUploadPool_WriterFenceWaitIsShared(t *testing.T) {
	defer setUploadConcurrencyForTest(4)()
	provider := &fencedPoolProvider{poolProvider: newPoolProvider()}
	files := poolFiles(t, 4)
	snapshot, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if len(snapshot.Files) != 4 {
		t.Fatalf("manifest has %d files, want 4", len(snapshot.Files))
	}
	provider.fmu.Lock()
	defer provider.fmu.Unlock()
	if provider.rejections < 2 {
		t.Fatalf("only %d upload(s) hit the fence; the shared wait was not exercised", provider.rejections)
	}
	if provider.awaits != 1 {
		t.Fatalf("AwaitWriteAccess called %d times for %d concurrent rejections, want 1", provider.awaits, provider.rejections)
	}
}
