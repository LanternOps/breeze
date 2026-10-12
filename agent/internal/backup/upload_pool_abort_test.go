package backup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// fileObjects counts the file objects (not control objects) stored.
func (p *poolProvider) fileObjects() int {
	p.mockProvider.mu.Lock()
	defer p.mockProvider.mu.Unlock()
	n := 0
	for k := range p.mockProvider.files {
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
func TestUploadPool_StopWithJournalThenResume(t *testing.T) {
	defer setUploadConcurrencyForTest(4)()
	files := poolFiles(t, 10)
	provider := newPoolProvider()
	provider.hold = func(ctx context.Context, remotePath string) error {
		if strings.Contains(remotePath, "f02") {
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
	go func() {
		// f00, f01 and three files behind the blocked f02 have landed.
		deadline := time.Now().Add(5 * time.Second)
		for provider.fileObjects() < 5 && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		cancel()
	}()
	if _, err := createSnapshotWithProgress(ctx, provider, files, nil, journal, nil, nil); !errors.Is(err, errBackupStopped) {
		t.Fatalf("err = %v, want errBackupStopped", err)
	}
	if got := provider.fileObjects(); got < 5 {
		t.Fatalf("only %d file objects landed; the stop was not exercised with finished files behind the head", got)
	}
	if active, _, _ := provider.snapshotStats(); active != 0 {
		t.Fatalf("run returned with %d uploads in flight", active)
	}
	provider.mockProvider.mu.Lock()
	deletes := len(provider.mockProvider.deleteCalls)
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
	for k, v := range provider.mockProvider.files {
		resumedProvider.mockProvider.files[k] = v
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
	for _, c := range resumedProvider.mockProvider.uploadCalls {
		if strings.Contains(c.remotePath, "f00") || strings.Contains(c.remotePath, "f01") {
			t.Fatalf("journaled file re-uploaded on resume: %s", c.remotePath)
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
func TestUploadPool_WriterStillActiveDrainsWorkers(t *testing.T) {
	defer setUploadConcurrencyForTest(4)()
	files := poolFiles(t, 10)
	provider := &stuckFenceProvider{poolProvider: newPoolProvider()}
	provider.ignoresCancel = true
	provider.hold = func(ctx context.Context, remotePath string) error {
		if strings.Contains(remotePath, "f00") || strings.Contains(remotePath, "f01") {
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
// opens.
type stuckFenceProvider struct{ *poolProvider }

func (p *stuckFenceProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	if strings.Contains(remotePath, "f02") {
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
