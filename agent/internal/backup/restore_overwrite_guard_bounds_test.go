package backup

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"runtime/metrics"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// The guard's memory follows the selection, not the snapshot (#11234's
// bound): a restore of one entry into a target inside the backed-up tree
// (every original lies beneath it, so the second pass runs) holds the same
// live heap whether the snapshot holds 10,000 originals or 200,000.
// Measured through RestoreFromSnapshot itself: the manifest downloaded
// from a provider and decoded with the guard observing every entry, then
// the second pass streamed from the retained manifest file. The collision
// is the manifest's last entry and is not selected, so a refusal naming it
// shows the second pass read to the end.
//
// Live heap is read at every garbage collection while the restore runs
// (peakLiveHeapDuring), so memory held only until it returns counts too.
// The measurement runs alone in a child process (this test binary, this
// test only): live heap counts every goroutine's allocations, and earlier
// tests in this package can leave goroutines running.
func TestOriginalsGuard_MemoryFollowsSelection(t *testing.T) {
	if os.Getenv(guardMemoryChildEnv) == "" {
		cmd := exec.Command(os.Args[0], "-test.run=^TestOriginalsGuard_MemoryFollowsSelection$", "-test.v", "-test.count=1", "-test.timeout=5m")
		cmd.Env = append(os.Environ(), guardMemoryChildEnv+"=1")
		out, err := cmd.CombinedOutput()
		t.Logf("isolated measurement:\n%s", out)
		if err != nil {
			t.Fatalf("isolated measurement failed: %v", err)
		}
		if !strings.Contains(string(out), guardMemoryMeasuredMarker) {
			t.Fatal("the isolated measurement did not run")
		}
		return
	}

	target := "/nonexistent-12638/srv"
	if runtime.GOOS == "windows" {
		target = `C:\nonexistent-12638\srv`
	}
	selected := originalUnder(target, 0)
	collision := resolveTargetPath(target, selected) // a backed-up nested copy, where selected restores

	growth := func(n int) int64 {
		provider, snapshotID := writeOriginalsManifest(t, n, target, collision)
		cfg := RestoreConfig{SnapshotID: snapshotID, TargetPath: target, WorkRoot: t.TempDir(), SelectedPaths: []string{selected}}
		var result *RestoreResult
		var err error
		before, peak := peakLiveHeapDuring(func() {
			result, err = RestoreFromSnapshot(provider, cfg, nil)
		})
		if err != nil || result.Code != ResultCodeRestoreWouldOverwriteOriginals || !strings.Contains(result.Error, selected+" would overwrite "+collision) {
			t.Fatalf("%d originals: restore = %+v, %v; want refused naming the nested copy only the second pass finds", n, result, err)
		}
		return peak - before
	}

	small, large := growth(10_000), growth(200_000)
	t.Logf("%s: peak live heap growth %d bytes for 10k originals, %d bytes for 200k", guardMemoryMeasuredMarker, small, large)
	// 1 MiB over 190,000 more originals is under 6 bytes each: holding
	// anything per original (a string, an 8-byte hash, a map entry) exceeds
	// it, while collection timing moves the peak by well under that.
	if large-small > 1<<20 {
		t.Fatalf("the restore holds %d more bytes for 200k originals than for 10k: the guard's memory grows with the snapshot", large-small)
	}
}

// peakLiveHeapDuring runs fn and returns the live heap before it and the
// largest live heap any garbage collection found while it ran: collection
// runs often (GOGC 5), and a finalizer re-armed at every cycle reads the
// heap that cycle left live.
func peakLiveHeapDuring(fn func()) (before, peak int64) {
	sample := []metrics.Sample{{Name: "/gc/heap/live:bytes"}}
	read := func() int64 {
		metrics.Read(sample)
		return int64(sample[0].Value.Uint64())
	}
	defer debug.SetGCPercent(debug.SetGCPercent(5))
	runtime.GC()
	before = read()

	var mu sync.Mutex
	observed := before
	var stopped atomic.Bool
	var arm func()
	arm = func() {
		runtime.SetFinalizer(new([16]byte), func(*[16]byte) {
			live := read()
			mu.Lock()
			observed = max(observed, live)
			mu.Unlock()
			if !stopped.Load() {
				arm()
			}
		})
	}
	arm()
	fn()
	stopped.Store(true)
	runtime.GC() // a last cycle, so the finalizer has read the heap fn left
	runtime.GC()
	mu.Lock()
	defer mu.Unlock()
	return before, max(observed, read())
}

const (
	guardMemoryChildEnv       = "BREEZE_TEST_GUARD_MEMORY_CHILD"
	guardMemoryMeasuredMarker = "guard memory measured"
)

// writeOriginalsManifest stores a manifest of n+2 originals beneath target:
// the entry to select first, the nested copy collision last. It is written
// entry by entry, so the fixture is not in memory when the test measures.
// No file objects are stored: the guard refuses before any is read.
func writeOriginalsManifest(t *testing.T, n int, target, collision string) (*providers.LocalProvider, string) {
	t.Helper()
	provider := privateTestLocalProvider(t, t.TempDir())
	const snapshotID = "guard-memory-snap"
	manifestPath := filepath.Join(t.TempDir(), "manifest.json")
	out, err := os.Create(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	w := bufio.NewWriter(out) // write errors are sticky: Flush reports them
	entry := func(i int, path string) {
		sep := ","
		if i == 0 {
			sep = ""
		}
		quoted, err := json.Marshal(path)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = fmt.Fprintf(w, `%s{"sourcePath":%s,"backupPath":"snapshots/%s/files/f%d.gz","size":1,"modTime":"2026-01-01T00:00:00Z"}`, sep, quoted, snapshotID, i)
	}
	_, _ = fmt.Fprintf(w, `{"id":%q,"timestamp":"2026-01-01T00:00:00Z","files":[`, snapshotID)
	for i := range n + 1 {
		entry(i, originalUnder(target, i))
	}
	entry(n+1, collision)
	_, _ = fmt.Fprintf(w, `],"size":%d}`, n+2)
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
	if err := provider.Upload(manifestPath, filepath.Join("snapshots", snapshotID, "manifest.json")); err != nil {
		t.Fatal(err)
	}
	return provider, snapshotID
}

func originalUnder(target string, i int) string {
	return filepath.Join(target, "data", fmt.Sprintf("d%d", i/100), fmt.Sprintf("f%d.txt", i))
}

// The second pass finds a backed-up nested copy wherever it sits in the
// manifest: before the selected entry it would be overwritten by, or after.
func TestRestoreFromSnapshot_NestedCopyFoundInEitherManifestOrder(t *testing.T) {
	for _, nestedFirst := range []bool{true, false} {
		dir, err := filepath.EvalSymlinks(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(dir, "target")
		if err := os.Mkdir(target, 0o755); err != nil {
			t.Fatal(err)
		}
		first := filepath.Join(target, "a.txt")
		nested := resolveTargetPath(target, first)
		files := [][2]string{{first, "one"}, {filepath.Join(target, "b.txt"), "other"}, {nested, "two"}}
		if nestedFirst {
			files = [][2]string{{nested, "two"}, {filepath.Join(target, "b.txt"), "other"}, {first, "one"}}
		}
		provider, snapshotID := setupRestoreTestSnapshotOrdered(t, files, nil)

		result, err := RestoreFromSnapshot(provider, RestoreConfig{
			SnapshotID: snapshotID, TargetPath: target, WorkRoot: t.TempDir(), SelectedPaths: []string{first},
		}, nil)
		if err != nil || result.Code != ResultCodeRestoreWouldOverwriteOriginals || !strings.Contains(result.Error, first+" would overwrite "+nested) {
			t.Fatalf("nested copy first=%v: restore = %+v, %v; want refused naming the nested copy", nestedFirst, result, err)
		}
		if entries, _ := os.ReadDir(target); len(entries) != 0 {
			t.Fatalf("nested copy first=%v: target holds %v after a refused restore", nestedFirst, entries)
		}
	}
}

// A second pass that cannot finish fails the check closed; an entry that
// lands on its own original (a volume-root target) is found without it.
func TestRefuseRestoreOverOriginals_SecondPassFailure(t *testing.T) {
	broken := errors.New("manifest read failed")
	failing := func(func(string)) error { return broken }

	g := newOriginalsGuard("/nonexistent-12638/target")
	selected := []SnapshotFile{{SourcePath: "/nonexistent-12638/target/x"}}
	noteAll(g, selected, nil)
	result := &RestoreResult{}
	if !refuseRestoreOverOriginals(g, selected, nil, nil, nil, failing, result) ||
		result.Code != ResultCodeRestoreOverwriteCheckFailed || !strings.Contains(result.Error, broken.Error()) ||
		strings.Contains(result.Error, "path below") {
		t.Fatalf("second pass failed: result %+v; want refused with %s", result, ResultCodeRestoreOverwriteCheckFailed)
	}

	g = newOriginalsGuard("/")
	selected = []SnapshotFile{{SourcePath: "/nonexistent-12638/x"}}
	noteAll(g, selected, nil)
	result = &RestoreResult{}
	if !refuseRestoreOverOriginals(g, selected, nil, nil, nil, failing, result) || result.Code != ResultCodeRestoreWouldOverwriteOriginals {
		t.Fatalf("volume-root target, second pass failed: result %+v; want the overwrite reported", result)
	}
}

// Paths quoted in a refusal are capped, so the advice and the code reach
// the server whole however long the path.
func TestOverwriteRefusals_CapQuotedPaths(t *testing.T) {
	long := "/" + strings.Repeat("d/", 3000) + "x"
	checkFailed := overwriteCheckFailedRefusal("/target", &uncheckedPathError{what: "restore destination", path: long, err: errUnplaceablePath})
	wouldOverwrite := alternateRestoreRefusal(long, overwriteFinding{count: 1, entry: long, overwrite: long + "/y"})
	for name, msg := range map[string]string{"check failed": checkFailed, "would overwrite": wouldOverwrite} {
		if n := utf8.RuneCountInString(msg); n > 2500 {
			t.Errorf("%s refusal is %d characters for a %d-character path; want each path capped", name, n, len(long))
		}
		if !strings.Contains(msg, "…") || !strings.Contains(msg, "new, empty folder") {
			t.Errorf("%s refusal %q: want the path cut with … and the advice kept", name, msg[:200])
		}
	}
}

// The advice comes before the path (a cut at the server's limit keeps it)
// and fits the path: a recorded path no target can fix asks for the staging
// location; anything else for a new, empty folder.
func TestOverwriteCheckFailedRefusal_AdviceFitsThePath(t *testing.T) {
	for what, advice := range map[string]string{"recorded path": "default staging location", "restore destination": "new, empty folder", "restore target": "new, empty folder"} {
		msg := overwriteCheckFailedRefusal("/target", &uncheckedPathError{what: what, path: "/data/x", err: errUnplaceablePath})
		if !strings.Contains(msg, "nothing was written") || !strings.Contains(msg, advice) || strings.Count(msg, "/data/x") != 1 {
			t.Errorf("%s: refusal %q; want the advice %q and the path once", what, msg, advice)
		}
		if strings.Index(msg, advice) > strings.Index(msg, "/data/x") {
			t.Errorf("%s: refusal %q names the path before the advice", what, msg)
		}
	}
}
