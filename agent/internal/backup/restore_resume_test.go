package backup

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// hookedDownloadProvider counts downloads per object and lets a test run a
// callback (and optionally fail the download) at a chosen object.
type hookedDownloadProvider struct {
	*providers.LocalProvider
	mu     sync.Mutex
	counts map[string]int
	before func(remotePath string) error
}

func (p *hookedDownloadProvider) Download(remotePath, localPath string) error {
	p.mu.Lock()
	p.counts[remotePath]++
	hook := p.before
	p.mu.Unlock()
	if hook != nil {
		if err := hook(remotePath); err != nil {
			return err
		}
	}
	return p.LocalProvider.Download(remotePath, localPath)
}

func (p *hookedDownloadProvider) count(remotePath string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.counts[remotePath]
}

func numberedTestFiles(n int) map[string]string {
	files := make(map[string]string, n)
	for i := 0; i < n; i++ {
		files[fmt.Sprintf("dir%02d/file-%04d.txt", i%7, i)] = strings.Repeat(fmt.Sprintf("content-%d;", i), 1+i%3)
	}
	return files
}

// resumeFilesOnDisk returns the resume-state artifacts (snapshot + journal)
// currently present in stagingDir, keyed by base name.
func resumeFilesOnDisk(t *testing.T, stagingDir string) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	entries, err := os.ReadDir(stagingDir)
	if err != nil {
		if os.IsNotExist(err) {
			return out
		}
		t.Fatalf("read staging dir: %v", err)
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "resume-") || strings.HasSuffix(e.Name(), ".tmp") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(stagingDir, e.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", e.Name(), err)
		}
		out[e.Name()] = data
	}
	return out
}

// #7333: the restore loop used to rewrite the whole resume-state file (a map
// of every completed path) after every file, so bytes written grew as O(N²).
// Resume persistence must now cost O(N) in total: bounded by a small multiple
// of the final state's size, with snapshot rewrites independent of N.
func TestRestoreFromSnapshot_ResumeStatePersistenceIsLinear(t *testing.T) {
	const n = 200
	baseProvider, snapID := setupRestoreTestSnapshot(t, numberedTestFiles(n))
	snapshot, err := downloadManifest(baseProvider, snapID, t.TempDir())
	if err != nil {
		t.Fatalf("download manifest: %v", err)
	}
	last := snapshot.Files[len(snapshot.Files)-1].BackupPath

	var saves int
	var snapshotBytes int
	restoreSave := saveResumeStateFn
	saveResumeStateFn = func(dir string, st *ResumeState) error {
		saves++
		data, _ := json.Marshal(st)
		snapshotBytes += len(data)
		return restoreSave(dir, st)
	}
	t.Cleanup(func() { saveResumeStateFn = restoreSave })

	targetDir := t.TempDir()
	workRoot := t.TempDir()
	cfg := RestoreConfig{SnapshotID: snapID, TargetPath: targetDir, WorkRoot: workRoot}
	stagingDir, err := restoreStagingDir(cfg, filepath.Join(workRoot, "restore-work"))
	if err != nil {
		t.Fatal(err)
	}

	// Measure the journal at its largest (just before the run ends) and fail
	// the last object so the run is partial and keeps its staging dir.
	var journalBytes int
	var savesBeforeLast int
	provider := &hookedDownloadProvider{LocalProvider: baseProvider, counts: map[string]int{}}
	provider.before = func(remotePath string) error {
		if remotePath != last {
			return nil
		}
		savesBeforeLast = saves
		for name, data := range resumeFilesOnDisk(t, stagingDir) {
			if name != resumeStateFile {
				journalBytes += len(data)
			}
		}
		return errors.New("injected failure on the last object")
	}

	result, err := RestoreFromSnapshot(provider, cfg, nil)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if result.Status != "partial" || result.FilesRestored != n-1 {
		t.Fatalf("status=%s restored=%d, want partial/%d", result.Status, result.FilesRestored, n-1)
	}

	final, err := LoadResumeState(stagingDir)
	if err != nil || final == nil {
		t.Fatalf("load final state: %v (nil=%v)", err, final == nil)
	}
	if len(final.CompletedFiles) != n-1 {
		t.Fatalf("final state has %d completed files, want %d", len(final.CompletedFiles), n-1)
	}
	finalJSON, _ := json.Marshal(final)

	if savesBeforeLast > 1 {
		t.Errorf("resume-state snapshot rewritten %d times during %d file installs; want O(1), not once per file", savesBeforeLast, n-1)
	}
	if saves > 2 {
		t.Errorf("resume-state snapshot rewritten %d times in total; want at most 2", saves)
	}
	total := snapshotBytes + journalBytes
	if bound := 3 * len(finalJSON); total > bound {
		t.Errorf("resume persistence wrote %d bytes for a %d-byte final state (%d files); want <= %d (linear)", total, len(finalJSON), n-1, bound)
	}
}

// crashImage is the on-disk state a killed agent leaves behind: the resume
// artifacts in the staging dir and every file already published to target.
type crashImage struct {
	resume map[string][]byte
	target map[string][]byte
}

func captureTree(t *testing.T, root string) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		out[rel] = data
		return nil
	})
	if err != nil {
		t.Fatalf("capture %s: %v", root, err)
	}
	return out
}

func writeTree(t *testing.T, root string, files map[string][]byte) {
	t.Helper()
	for rel, data := range files {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// A crash (no orderly shutdown, so no compaction) at any point of the file
// pass must resume: nothing completed before the crash is downloaded again,
// everything after it is, and the result is a complete, correct restore. A
// torn final journal line costs exactly one re-download (the last completed
// file), which is safe because re-installing a verified file is idempotent.
//
// The crash image is captured from the progress callback, which runs on the
// install goroutine between installs: with concurrent downloads (#5623) the
// objects after the crash point may already be downloading into staging, but
// the target tree and the journal only change on that goroutine, so this is
// the state a kill at that instant leaves behind. Run serially and
// concurrently: the resume contract must not depend on download concurrency.
func TestRestoreFromSnapshot_ResumesFromCrashAtArbitraryPoints(t *testing.T) {
	const n = 12
	contents := numberedTestFiles(n)
	for _, workers := range []int{1, 4} {
		for _, crashAt := range []int{0, 1, 5, n - 1} {
			for _, torn := range []bool{false, true} {
				if torn && crashAt == 0 {
					continue
				}
				t.Run(fmt.Sprintf("workers=%d/crashAt=%d/torn=%v", workers, crashAt, torn), func(t *testing.T) {
					defer setRestoreConcurrencyForTest(workers)()
					baseProvider, snapID := setupRestoreTestSnapshot(t, contents)
					snapshot, err := downloadManifest(baseProvider, snapID, t.TempDir())
					if err != nil {
						t.Fatalf("download manifest: %v", err)
					}
					targetDir := t.TempDir()
					workRoot := t.TempDir()
					cfg := RestoreConfig{SnapshotID: snapID, TargetPath: targetDir, WorkRoot: workRoot}
					stagingDir, err := restoreStagingDir(cfg, filepath.Join(workRoot, "restore-work"))
					if err != nil {
						t.Fatal(err)
					}

					// Run 1: snapshot the disk the instant crashAt files are
					// installed, then fail every download from there on.
					var image *crashImage
					var dead atomic.Bool
					run1 := &hookedDownloadProvider{LocalProvider: baseProvider, counts: map[string]int{}}
					run1.before = func(string) error {
						if dead.Load() {
							return errors.New("agent is dead")
						}
						return nil
					}
					progress := func(phase string, current, _ int64, _ string) {
						atCrash := (crashAt == 0 && phase == "starting") || (phase == "restoring" && current == int64(crashAt))
						if atCrash && image == nil {
							image = &crashImage{resume: resumeFilesOnDisk(t, stagingDir), target: captureTree(t, targetDir)}
							dead.Store(true)
						}
					}
					if _, err := RestoreFromSnapshot(run1, cfg, progress); err != nil {
						t.Fatalf("run 1: %v", err)
					}
					if image == nil {
						t.Fatal("crash point never reached")
					}

					// Rebuild exactly the crashed disk.
					for _, dir := range []string{stagingDir, targetDir} {
						if err := os.RemoveAll(dir); err != nil {
							t.Fatal(err)
						}
					}
					if err := os.MkdirAll(stagingDir, 0o700); err != nil {
						t.Fatal(err)
					}
					if err := os.MkdirAll(targetDir, 0o700); err != nil {
						t.Fatal(err)
					}
					if torn {
						journal, ok := image.resume[resumeJournalFile]
						if !ok || len(journal) < 4 {
							t.Fatalf("expected a journal in the crash image, got %v", keysOf(image.resume))
						}
						image.resume[resumeJournalFile] = journal[:len(journal)-4]
					}
					writeTree(t, stagingDir, image.resume)
					writeTree(t, targetDir, image.target)

					run2 := &hookedDownloadProvider{LocalProvider: baseProvider, counts: map[string]int{}}
					result, err := RestoreFromSnapshot(run2, cfg, nil)
					if err != nil {
						t.Fatalf("run 2: %v", err)
					}
					if result.Status != "completed" || result.FilesRestored != n {
						t.Fatalf("run 2: status=%s restored=%d failed=%v, want completed/%d", result.Status, result.FilesRestored, result.FailedFiles, n)
					}
					for i, f := range snapshot.Files {
						want := 1
						if i < crashAt {
							want = 0
							if torn && i == crashAt-1 {
								want = 1
							}
						}
						if got := run2.count(f.BackupPath); got != want {
							t.Errorf("file %d (%s) downloaded %d times on resume, want %d", i, f.BackupPath, got, want)
						}
					}
					for name, content := range contents {
						got, err := os.ReadFile(resolveTargetPath(targetDir, filepath.Join("/original", name)))
						if err != nil || string(got) != content {
							t.Errorf("%s: got %q (err %v), want %q", name, got, err, content)
						}
					}
				})
			}
		}
	}
}

func keysOf(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// An agent upgraded mid-restore finds only the resume-state.json the previous
// version wrote (whole-map snapshot, no journal) and must resume from it.
func TestRestoreFromSnapshot_ResumesFromLegacyResumeStateFile(t *testing.T) {
	contents := map[string]string{"file1.txt": "content1\n", "file2.txt": "content2\n"}
	baseProvider, snapID := setupRestoreTestSnapshot(t, contents)
	snapshot, err := downloadManifest(baseProvider, snapID, t.TempDir())
	if err != nil {
		t.Fatalf("download manifest: %v", err)
	}
	done, pending := snapshot.Files[0], snapshot.Files[1]

	targetDir := t.TempDir()
	workRoot := t.TempDir()
	cfg := RestoreConfig{SnapshotID: snapID, TargetPath: targetDir, WorkRoot: workRoot}
	stagingDir, err := restoreStagingDir(cfg, filepath.Join(workRoot, "restore-work"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stagingDir, 0o700); err != nil {
		t.Fatal(err)
	}
	// Byte-for-byte what the previous agent's SaveResumeState emitted.
	legacy := fmt.Sprintf(`{"snapshotId":%q,"completedFiles":{%q:true},"bytesRestored":%d}`, snapID, done.BackupPath, done.Size)
	if err := os.WriteFile(filepath.Join(stagingDir, resumeStateFile), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	doneTarget := resolveTargetPath(targetDir, done.SourcePath)
	if err := os.MkdirAll(filepath.Dir(doneTarget), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(doneTarget, []byte(contents[filepath.Base(done.SourcePath)]), 0o600); err != nil {
		t.Fatal(err)
	}

	provider := &hookedDownloadProvider{LocalProvider: baseProvider, counts: map[string]int{}}
	result, err := RestoreFromSnapshot(provider, cfg, nil)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if result.Status != "completed" || result.FilesRestored != 2 {
		t.Fatalf("status=%s restored=%d, want completed/2", result.Status, result.FilesRestored)
	}
	if got := provider.count(done.BackupPath); got != 0 {
		t.Errorf("legacy-completed file downloaded %d times, want 0", got)
	}
	if got := provider.count(pending.BackupPath); got != 1 {
		t.Errorf("pending file downloaded %d times, want 1", got)
	}
}

func writeJournalLines(t *testing.T, dir string, raw string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, resumeJournalFile), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
}

func journalLine(path string, size int64) string {
	data, _ := json.Marshal(resumeJournalRecord{Path: path, Size: size})
	return string(data) + "\n"
}

func TestResumeTracker_ReplaysJournalOverSnapshotAndCompacts(t *testing.T) {
	dir := t.TempDir()
	if err := SaveResumeState(dir, &ResumeState{SnapshotID: "s", CompletedFiles: map[string]bool{"a": true}, BytesRestored: 10}); err != nil {
		t.Fatal(err)
	}
	// "a" repeated: a crash between compaction's rename and its journal
	// removal leaves journal records the snapshot already holds; replay must
	// not double-count them.
	writeJournalLines(t, dir, journalLine("a", 10)+journalLine("b", 20)+journalLine("c", 30))

	tr := openResumeTracker(dir, "s")
	defer tr.discard()
	for _, p := range []string{"a", "b", "c"} {
		if !tr.completed(p) {
			t.Errorf("%s not completed after replay", p)
		}
	}
	if tr.state.BytesRestored != 60 {
		t.Errorf("BytesRestored = %d, want 60", tr.state.BytesRestored)
	}
	// Compacted on open: the snapshot alone (what an older agent reads) now
	// holds everything, and the journal is gone.
	st, err := LoadResumeState(dir)
	if err != nil || st == nil || len(st.CompletedFiles) != 3 || st.BytesRestored != 60 {
		t.Fatalf("compacted snapshot = %+v (err %v), want a,b,c / 60", st, err)
	}
	if _, err := os.Stat(filepath.Join(dir, resumeJournalFile)); !os.IsNotExist(err) {
		t.Errorf("journal still present after compaction: %v", err)
	}
}

func TestResumeTracker_TornAndGarbageLinesAreSkipped(t *testing.T) {
	dir := t.TempDir()
	full := journalLine("c", 3)
	writeJournalLines(t, dir, journalLine("a", 1)+"\x00\x00\x00\n"+"not json\n"+journalLine("b", 2)+`{"p":""}`+"\n"+full[:len(full)-3])

	tr := openResumeTracker(dir, "s")
	defer tr.discard()
	if !tr.completed("a") || !tr.completed("b") {
		t.Error("intact records around the damage were not replayed")
	}
	if tr.completed("c") {
		t.Error("torn final record was treated as completed")
	}
	if len(tr.state.CompletedFiles) != 2 {
		t.Errorf("completed = %v, want only a and b", tr.state.CompletedFiles)
	}
}

// When compaction on open cannot write the snapshot, the tracker keeps
// appending to the existing journal; a record appended after a torn tail
// must land on its own line and survive the next replay.
func TestResumeTracker_AppendAfterTornTailWhenCompactionFails(t *testing.T) {
	dir := t.TempDir()
	// A directory where the snapshot belongs makes both the snapshot read
	// and the compaction's rename fail.
	if err := os.Mkdir(filepath.Join(dir, resumeStateFile), 0o700); err != nil {
		t.Fatal(err)
	}
	torn := journalLine("b", 2)
	writeJournalLines(t, dir, journalLine("a", 1)+torn[:len(torn)-5])

	tr := openResumeTracker(dir, "s")
	tr.markCompleted("c", 3)
	tr.close() // compaction fails again; the journal must stay authoritative

	if err := os.Remove(filepath.Join(dir, resumeStateFile)); err != nil {
		t.Fatal(err)
	}
	tr2 := openResumeTracker(dir, "s")
	defer tr2.discard()
	if !tr2.completed("a") || !tr2.completed("c") {
		t.Errorf("completed = %v, want a and c", tr2.state.CompletedFiles)
	}
	if tr2.completed("b") {
		t.Error("torn record b was treated as completed")
	}
}

func TestResumeTracker_CloseCompactsForOlderReaders(t *testing.T) {
	dir := t.TempDir()
	tr := openResumeTracker(dir, "snap")
	tr.markCompleted("a", 5)
	tr.markCompleted("b", 7)
	tr.close()
	tr.close() // idempotent

	st, err := LoadResumeState(dir)
	if err != nil || st == nil {
		t.Fatalf("load: %v", err)
	}
	if st.SnapshotID != "snap" || !st.CompletedFiles["a"] || !st.CompletedFiles["b"] || st.BytesRestored != 12 {
		t.Errorf("snapshot = %+v, want snap / a,b / 12", st)
	}
	if _, err := os.Stat(filepath.Join(dir, resumeJournalFile)); !os.IsNotExist(err) {
		t.Errorf("journal still present after close: %v", err)
	}
}

func TestResumeTracker_FreshRunWritesNothingUntilAFileCompletes(t *testing.T) {
	dir := t.TempDir()
	tr := openResumeTracker(dir, "snap")
	tr.close()
	if files := resumeFilesOnDisk(t, dir); len(files) != 0 {
		t.Errorf("idle tracker wrote %v", keysOf(files))
	}
}

func TestResumeTracker_NullCompletedFilesInLegacySnapshot(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, resumeStateFile), []byte(`{"snapshotId":"s","completedFiles":null,"bytesRestored":0}`), 0o600); err != nil {
		t.Fatal(err)
	}
	tr := openResumeTracker(dir, "s")
	defer tr.discard()
	tr.markCompleted("a", 1) // must not panic on a nil map
	if !tr.completed("a") {
		t.Error("a not completed")
	}
}

// If the journal cannot be created, progress lives only in memory until the
// run ends: resume decisions stay correct in-process and close() still
// writes a complete snapshot.
func TestResumeTracker_JournalUnavailableStillCompactsOnClose(t *testing.T) {
	dir := t.TempDir()
	// A non-empty directory where the journal belongs: replay fails, the
	// compaction cannot remove it, and opening it for append fails.
	if err := os.MkdirAll(filepath.Join(dir, resumeJournalFile, "x"), 0o700); err != nil {
		t.Fatal(err)
	}

	tr := openResumeTracker(dir, "snap")
	tr.markCompleted("a", 1)
	tr.markCompleted("b", 2)
	if !tr.journalDisabled {
		t.Fatal("journal unexpectedly opened; the test no longer exercises the degraded path")
	}
	if !tr.completed("a") || !tr.completed("b") {
		t.Errorf("in-memory state lost records: %v", tr.state.CompletedFiles)
	}
	tr.close()

	st, err := LoadResumeState(dir)
	if err != nil || st == nil || !st.CompletedFiles["a"] || !st.CompletedFiles["b"] || st.BytesRestored != 3 {
		t.Fatalf("snapshot after close = %+v (err %v), want a,b / 3", st, err)
	}
}
