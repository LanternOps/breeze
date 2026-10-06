package backup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// restoreEntry is one manifest entry for writeRestoreSnapshot: content is
// uploaded under key (deduplicated, so two entries may share a key), and the
// entry restores to /original/<source>.
type restoreEntry struct {
	source  string
	key     string
	content string
	// rawSource, when set, is the manifest SourcePath verbatim (uncleaned),
	// for entries the restore must refuse.
	rawSource string
}

// writeRestoreSnapshot builds a snapshot whose manifest lists entries in
// exactly the given order (setupRestoreTestSnapshot ranges over a map).
func writeRestoreSnapshot(t *testing.T, entries []restoreEntry) (*providers.LocalProvider, string) {
	t.Helper()
	provider := providers.NewLocalProvider(t.TempDir())
	snapshotID := "test-snap-content"
	prefix := path.Join("snapshots", snapshotID)
	uploaded := map[string]bool{}
	var files []SnapshotFile
	for _, e := range entries {
		key := path.Join(prefix, "files", e.key+".gz")
		if !uploaded[key] {
			src := filepath.Join(t.TempDir(), "src")
			if err := os.WriteFile(src, []byte(e.content), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := provider.Upload(src, key); err != nil {
				t.Fatalf("upload %s: %v", key, err)
			}
			uploaded[key] = true
		}
		source := path.Join("/original", e.source)
		if e.rawSource != "" {
			source = e.rawSource
		}
		files = append(files, SnapshotFile{
			SourcePath: source,
			BackupPath: key,
			Size:       int64(len(e.content)),
			ModTime:    time.Now().UTC(),
		})
	}
	data, err := json.Marshal(Snapshot{ID: snapshotID, Timestamp: time.Now().UTC(), Files: files, Size: totalSize(files)})
	if err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(manifest, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := provider.Upload(manifest, path.Join(prefix, "manifest.json")); err != nil {
		t.Fatal(err)
	}
	return provider, snapshotID
}

func numberedEntries(n int) []restoreEntry {
	entries := make([]restoreEntry, n)
	for i := range entries {
		name := fmt.Sprintf("dir%d/file-%03d.txt", i%3, i)
		entries[i] = restoreEntry{source: name, key: name, content: strings.Repeat(fmt.Sprintf("c%d;", i), 1+i%4)}
	}
	return entries
}

// gatedProvider tracks how many downloads run at once (overall and per
// object) and lets a test delay individual objects.
type gatedProvider struct {
	*providers.LocalProvider
	delay func(remotePath string) time.Duration
	fail  func(remotePath string) error

	mu        sync.Mutex
	active    int
	peak      int
	perKey    map[string]int
	keyPeak   int
	downloads map[string]int
}

func newGatedProvider(base *providers.LocalProvider) *gatedProvider {
	return &gatedProvider{LocalProvider: base, perKey: map[string]int{}, downloads: map[string]int{}}
}

func (p *gatedProvider) Download(remotePath, localPath string) error {
	p.mu.Lock()
	p.active++
	p.peak = max(p.peak, p.active)
	p.perKey[remotePath]++
	p.keyPeak = max(p.keyPeak, p.perKey[remotePath])
	p.downloads[remotePath]++
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.active--
		p.perKey[remotePath]--
		p.mu.Unlock()
	}()
	if p.delay != nil {
		time.Sleep(p.delay(remotePath))
	}
	if p.fail != nil {
		if err := p.fail(remotePath); err != nil {
			return err
		}
	}
	return p.LocalProvider.Download(remotePath, localPath)
}

func (p *gatedProvider) stats() (active, peak, keyPeak int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.active, p.peak, p.keyPeak
}

func (p *gatedProvider) count(remotePath string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.downloads[remotePath]
}

func manifestFiles(t *testing.T, provider providers.BackupProvider, snapID string) []SnapshotFile {
	t.Helper()
	snap, err := downloadManifest(provider, snapID, t.TempDir())
	if err != nil {
		t.Fatalf("download manifest: %v", err)
	}
	return snap.Files
}

// #5623: the file pass downloaded one object per round trip. With the
// default concurrency, several downloads must be in flight at once.
func TestRestoreContent_DownloadsRunConcurrently(t *testing.T) {
	base, snapID := writeRestoreSnapshot(t, numberedEntries(24))
	provider := newGatedProvider(base)
	provider.delay = func(string) time.Duration { return 20 * time.Millisecond }

	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapID, TargetPath: t.TempDir(), WorkRoot: t.TempDir()}, nil)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if result.Status != "completed" || result.FilesRestored != 24 {
		t.Fatalf("status=%s restored=%d failed=%v", result.Status, result.FilesRestored, result.FailedFiles)
	}
	_, peak, _ := provider.stats()
	if peak < 2 {
		t.Fatalf("peak concurrent downloads = %d; want the file pass to download in parallel", peak)
	}
	if peak > restoreDownloadConcurrency {
		t.Fatalf("peak concurrent downloads = %d, above the bound of %d", peak, restoreDownloadConcurrency)
	}
}

// Downloads finish out of order, but installs, journal appends and progress
// must follow manifest order, exactly as the serial loop did: each progress
// call comes after that file's journal record and install.
func TestRestoreContent_InstallsJournalsAndReportsInManifestOrder(t *testing.T) {
	defer setRestoreConcurrencyForTest(4)()
	const n = 16
	base, snapID := writeRestoreSnapshot(t, numberedEntries(n))
	files := manifestFiles(t, base, snapID)
	order := map[string]int{}
	for i, f := range files {
		order[f.BackupPath] = i
	}
	provider := newGatedProvider(base)
	// Earlier entries take longer, so completion order inverts each window.
	provider.delay = func(key string) time.Duration { return time.Duration(n-order[key]) * 3 * time.Millisecond }
	last := files[n-1].BackupPath
	provider.fail = func(key string) error {
		if key == last {
			return errors.New("injected: keep the staging dir")
		}
		return nil
	}

	targetDir, workRoot := t.TempDir(), t.TempDir()
	cfg := RestoreConfig{SnapshotID: snapID, TargetPath: targetDir, WorkRoot: workRoot}
	stagingDir, err := restoreStagingDir(cfg, filepath.Join(workRoot, "restore-work"))
	if err != nil {
		t.Fatal(err)
	}

	var got []int64
	progress := func(phase string, current, _ int64, msg string) {
		if phase != "restoring" {
			return
		}
		got = append(got, current)
		f := files[current-1]
		if want := "restored: " + restoreSourcePath(f); msg != want {
			t.Errorf("progress %d: message %q, want %q", current, msg, want)
		}
		if _, err := os.Stat(resolveTargetPath(targetDir, restoreSourcePath(f))); err != nil {
			t.Errorf("progress %d reported before %s was installed: %v", current, f.SourcePath, err)
		}
		journal, _ := os.ReadFile(filepath.Join(stagingDir, resumeJournalFile))
		lines := bytes.Split(bytes.TrimSpace(journal), []byte("\n"))
		var rec resumeJournalRecord
		if len(lines) != int(current) || json.Unmarshal(lines[len(lines)-1], &rec) != nil || rec.Path != f.BackupPath {
			t.Errorf("progress %d: journal has %d records ending %q, want %d ending %q", current, len(lines), rec.Path, current, f.BackupPath)
		}
	}
	result, err := RestoreFromSnapshot(provider, cfg, progress)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if result.Status != "partial" || result.FilesRestored != n-1 || len(result.FailedFiles) != 1 {
		t.Fatalf("status=%s restored=%d failed=%v, want partial/%d/1", result.Status, result.FilesRestored, result.FailedFiles, n-1)
	}
	for i, c := range got {
		if c != int64(i+1) {
			t.Fatalf("progress sequence %v is not manifest order", got)
		}
	}
	if len(got) != n-1 {
		t.Fatalf("got %d progress calls, want %d", len(got), n-1)
	}
}

// Two entries restoring onto one target (a case twin landing on NTFS): the
// later manifest entry must still win even when its download finishes
// first, because installs stay in manifest order.
func TestRestoreContent_LaterEntryForSameTargetStillWins(t *testing.T) {
	defer setRestoreConcurrencyForTest(4)()
	base, snapID := writeRestoreSnapshot(t, []restoreEntry{
		{source: "shared.txt", key: "first", content: "first-version"},
		{source: "other.txt", key: "other", content: "other"},
		{source: "shared.txt", key: "second", content: "second-version!"},
	})
	provider := newGatedProvider(base)
	provider.delay = func(key string) time.Duration {
		if strings.HasSuffix(key, "/first.gz") {
			return 150 * time.Millisecond
		}
		return 0
	}
	targetDir := t.TempDir()
	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapID, TargetPath: targetDir, WorkRoot: t.TempDir()}, nil)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if result.Status != "completed" {
		t.Fatalf("status=%s failed=%v", result.Status, result.FailedFiles)
	}
	got, err := os.ReadFile(resolveTargetPath(targetDir, "/original/shared.txt"))
	if err != nil || string(got) != "second-version!" {
		t.Fatalf("shared.txt = %q (err %v), want the later manifest entry's bytes", got, err)
	}
}

// Two entries backed by one object share a staging file name; they must
// never download into it at the same time.
func TestRestoreContent_SameObjectIsNeverStagedTwiceAtOnce(t *testing.T) {
	defer setRestoreConcurrencyForTest(4)()
	base, snapID := writeRestoreSnapshot(t, []restoreEntry{
		{source: "a/copy1.txt", key: "blob", content: "same-bytes"},
		{source: "a/copy2.txt", key: "blob", content: "same-bytes"},
		{source: "a/copy3.txt", key: "blob", content: "same-bytes"},
		{source: "a/else.txt", key: "else", content: "else"},
	})
	provider := newGatedProvider(base)
	provider.delay = func(string) time.Duration { return 30 * time.Millisecond }
	targetDir := t.TempDir()
	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapID, TargetPath: targetDir, WorkRoot: t.TempDir()}, nil)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if result.Status != "completed" || result.FilesRestored != 4 {
		t.Fatalf("status=%s restored=%d failed=%v", result.Status, result.FilesRestored, result.FailedFiles)
	}
	if _, _, keyPeak := provider.stats(); keyPeak != 1 {
		t.Fatalf("one object was downloaded %d times concurrently into the same staging file", keyPeak)
	}
	for _, name := range []string{"a/copy1.txt", "a/copy2.txt", "a/copy3.txt"} {
		if got, err := os.ReadFile(resolveTargetPath(targetDir, "/original/"+name)); err != nil || string(got) != "same-bytes" {
			t.Errorf("%s = %q (err %v)", name, got, err)
		}
	}
}

// Cancellation mid-pass: the restore returns partial only after every
// download it started has returned, leaves no staged object behind, and the
// files it reported restored are journaled so a resumed run skips them.
func TestRestoreContent_CancelDrainsDownloadsAndResumes(t *testing.T) {
	defer setRestoreConcurrencyForTest(4)()
	const n, cancelAfter = 20, 3
	base, snapID := writeRestoreSnapshot(t, numberedEntries(n))
	files := manifestFiles(t, base, snapID)
	provider := newGatedProvider(base)
	provider.delay = func(string) time.Duration { return 25 * time.Millisecond }

	targetDir, workRoot := t.TempDir(), t.TempDir()
	cfg := RestoreConfig{SnapshotID: snapID, TargetPath: targetDir, WorkRoot: workRoot}
	stagingDir, err := restoreStagingDir(cfg, filepath.Join(workRoot, "restore-work"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	progress := func(phase string, current, _ int64, _ string) {
		if phase == "restoring" && current == cancelAfter {
			cancel()
		}
	}
	result, err := RestoreFromSnapshotContext(ctx, provider, cfg, progress)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if active, peak, _ := provider.stats(); active != 0 {
		t.Fatalf("restore returned with %d downloads still running", active)
	} else if peak < 2 {
		t.Fatalf("peak concurrent downloads = %d; the cancellation was not exercised with downloads in flight", peak)
	}
	if result.Status != "partial" || result.FilesRestored != cancelAfter || result.FilesFailed != 0 {
		t.Fatalf("status=%s restored=%d failed=%d, want partial/%d/0", result.Status, result.FilesRestored, result.FilesFailed, cancelAfter)
	}
	entries, err := os.ReadDir(stagingDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".gz") {
			t.Errorf("staged object %s left behind after cancellation", e.Name())
		}
	}
	state, err := LoadResumeState(stagingDir)
	if err != nil || state == nil || len(state.CompletedFiles) != cancelAfter {
		t.Fatalf("resume state after cancel: %+v (err %v), want %d completed", state, err, cancelAfter)
	}

	resumed := newGatedProvider(base)
	result, err = RestoreFromSnapshot(resumed, cfg, nil)
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if result.Status != "completed" || result.FilesRestored != n {
		t.Fatalf("resume: status=%s restored=%d failed=%v", result.Status, result.FilesRestored, result.FailedFiles)
	}
	for i, f := range files {
		want := 1
		if i < cancelAfter {
			want = 0
		}
		if got := resumed.count(f.BackupPath); got != want {
			t.Errorf("file %d downloaded %d times on resume, want %d", i, got, want)
		}
	}
}

// The staged-bytes budget caps how much downloaded-but-uninstalled data the
// staging dir holds; a file larger than the whole budget still restores, on
// its own.
func TestRestoreContent_StagedBytesBudgetBoundsParallelDownloads(t *testing.T) {
	defer setRestoreConcurrencyForTest(8)()
	const size = 1000
	old := restoreStagedBytesBudget
	restoreStagedBytesBudget = 2*size + size/2
	defer func() { restoreStagedBytesBudget = old }()

	var entries []restoreEntry
	for i := 0; i < 10; i++ {
		entries = append(entries, restoreEntry{source: fmt.Sprintf("f%02d", i), key: fmt.Sprintf("f%02d", i), content: strings.Repeat(string(rune('a'+i)), size)})
	}
	entries = append(entries, restoreEntry{source: "big", key: "big", content: strings.Repeat("B", 4*size)})
	base, snapID := writeRestoreSnapshot(t, entries)
	provider := newGatedProvider(base)
	provider.delay = func(string) time.Duration { return 20 * time.Millisecond }

	targetDir := t.TempDir()
	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapID, TargetPath: targetDir, WorkRoot: t.TempDir()}, nil)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if result.Status != "completed" || result.FilesRestored != len(entries) {
		t.Fatalf("status=%s restored=%d failed=%v", result.Status, result.FilesRestored, result.FailedFiles)
	}
	if _, peak, _ := provider.stats(); peak != 2 {
		t.Fatalf("peak concurrent downloads = %d; want exactly 2 under a %d-byte budget of %d-byte files", peak, restoreStagedBytesBudget, size)
	}
	if got, err := os.ReadFile(resolveTargetPath(targetDir, "/original/big")); err != nil || len(got) != 4*size {
		t.Fatalf("oversize file: %d bytes (err %v)", len(got), err)
	}
}

// A journaled file whose target no longer matches is fetched again at
// install time, in order, and re-journaled.
func TestRestoreContent_ResumedEntryWithChangedTargetIsRestoredAgain(t *testing.T) {
	defer setRestoreConcurrencyForTest(4)()
	base, snapID := writeRestoreSnapshot(t, numberedEntries(6))
	files := manifestFiles(t, base, snapID)
	targetDir, workRoot := t.TempDir(), t.TempDir()
	cfg := RestoreConfig{SnapshotID: snapID, TargetPath: targetDir, WorkRoot: workRoot}
	stagingDir, err := restoreStagingDir(cfg, filepath.Join(workRoot, "restore-work"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stagingDir, 0o700); err != nil {
		t.Fatal(err)
	}
	// Journal every file as done, but leave file 2's target truncated.
	state := &ResumeState{SnapshotID: snapID, CompletedFiles: map[string]bool{}}
	for i, f := range files {
		state.CompletedFiles[f.BackupPath] = true
		target := resolveTargetPath(targetDir, restoreSourcePath(f))
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			t.Fatal(err)
		}
		data := make([]byte, f.Size)
		if i == 2 {
			data = data[:len(data)-1]
		}
		if err := os.WriteFile(target, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := SaveResumeState(stagingDir, state); err != nil {
		t.Fatal(err)
	}

	provider := newGatedProvider(base)
	var msgs []string
	result, err := RestoreFromSnapshot(provider, cfg, func(phase string, _, _ int64, msg string) {
		if phase == "restoring" {
			msgs = append(msgs, msg)
		}
	})
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if result.Status != "completed" || result.FilesRestored != 6 {
		t.Fatalf("status=%s restored=%d failed=%v", result.Status, result.FilesRestored, result.FailedFiles)
	}
	for i, f := range files {
		want := 0
		prefix := "skipped (resumed): "
		if i == 2 {
			want, prefix = 1, "restored: "
		}
		if got := provider.count(f.BackupPath); got != want {
			t.Errorf("file %d downloaded %d times, want %d", i, got, want)
		}
		if msgs[i] != prefix+restoreSourcePath(f) {
			t.Errorf("progress %d = %q, want prefix %q", i, msgs[i], prefix)
		}
	}
	got, err := os.ReadFile(resolveTargetPath(targetDir, restoreSourcePath(files[2])))
	if err != nil || int64(len(got)) != files[2].Size || bytes.Equal(got, make([]byte, files[2].Size)) {
		t.Fatalf("file 2 not re-restored with real content: %q (err %v)", got, err)
	}
}

// A failed download and a refused path in the middle of the window must not
// stall or skew the pipeline: the entries behind them still download,
// install and journal, and the failures are counted exactly once each.
func TestRestoreContent_MidWindowFailuresDoNotStallThePass(t *testing.T) {
	defer setRestoreConcurrencyForTest(4)()
	entries := numberedEntries(20)
	entries[3].key = "fails"
	entries[7] = restoreEntry{rawSource: "../escape.txt", key: "escape", content: "nope"}
	base, snapID := writeRestoreSnapshot(t, entries)
	provider := newGatedProvider(base)
	provider.delay = func(string) time.Duration { return 10 * time.Millisecond }
	provider.fail = func(key string) error {
		if strings.HasSuffix(key, "/fails.gz") {
			return errors.New("injected download failure")
		}
		return nil
	}
	targetDir, workRoot := t.TempDir(), t.TempDir()
	cfg := RestoreConfig{SnapshotID: snapID, TargetPath: targetDir, WorkRoot: workRoot}
	stagingDir, err := restoreStagingDir(cfg, filepath.Join(workRoot, "restore-work"))
	if err != nil {
		t.Fatal(err)
	}
	result, err := RestoreFromSnapshot(provider, cfg, nil)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if result.Status != "partial" || result.FilesRestored != 18 || result.FilesFailed != 2 || len(result.FailedFiles) != 2 {
		t.Fatalf("status=%s restored=%d failed=%d %v, want partial/18/2", result.Status, result.FilesRestored, result.FilesFailed, result.FailedFiles)
	}
	if provider.count("snapshots/test-snap-content/files/escape.gz") != 0 {
		t.Error("a refused path was downloaded")
	}
	for i, e := range entries {
		if i == 3 || i == 7 {
			continue
		}
		if got, err := os.ReadFile(resolveTargetPath(targetDir, "/original/"+e.source)); err != nil || string(got) != e.content {
			t.Errorf("entry %d: %q (err %v)", i, got, err)
		}
	}
	state, err := LoadResumeState(stagingDir)
	if err != nil || state == nil || len(state.CompletedFiles) != 18 {
		t.Fatalf("resume state: %+v (err %v), want 18 completed", state, err)
	}
	staged, _ := os.ReadDir(stagingDir)
	for _, e := range staged {
		if strings.HasSuffix(e.Name(), ".gz") {
			t.Errorf("staged object %s left behind", e.Name())
		}
	}
}
