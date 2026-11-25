package backup

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unicode/utf8"
)

// The guard's memory follows the selection, not the snapshot (#11234's
// bound): a restore of one entry into a target inside the backed-up tree
// (every original lies beneath it) retains the same, whether the snapshot
// holds 10,000 originals or 200,000. Measured after the manifest pass and
// at the end of the second pass, where the guard holds the most.
func TestOriginalsGuard_MemoryFollowsSelection(t *testing.T) {
	const target = "/nonexistent-12638/srv"
	selected := []string{target + "/data/d0/f0.txt"}
	collision := target + target + "/data/d0/f0.txt" // where selected[0] restores

	retained := func(n int) int64 {
		originals := func(yield func(string)) {
			for i := range n {
				yield(fmt.Sprintf("%s/data/d%d/f%d.txt", target, i/100, i))
			}
			yield(collision) // a backed-up nested copy, last in the manifest
		}
		before := liveHeap()
		g := newOriginalsGuard(target)
		originals(g.noteOriginal)
		peak := liveHeap()
		f := g.check(selected, func(yield func(string)) error {
			originals(yield)
			peak = max(peak, liveHeap())
			return nil
		})
		if f.count != 1 || f.overwrite != collision {
			t.Fatalf("%d originals: finding %+v; want the nested copy found", n, f)
		}
		runtime.KeepAlive(g)
		return peak - before
	}

	small, large := retained(10_000), retained(200_000)
	t.Logf("guard heap growth: %d bytes for 10k originals, %d bytes for 200k", small, large)
	if large-small > 1<<20 {
		t.Fatalf("guard holds %d more bytes for 200k originals than for 10k: its memory grows with the snapshot", large-small)
	}
}

func liveHeap() int64 {
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return int64(m.HeapAlloc)
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
	// Identity sees nothing, so only the lexical self-collision can find it.
	g.identity = newFakeIdentityCheck("/", stylePOSIX, func(string) (os.FileInfo, error) { return nil, fs.ErrNotExist })
	selected = []SnapshotFile{{SourcePath: "/nonexistent-12638/x"}}
	noteAll(g, selected, nil)
	result = &RestoreResult{}
	if !refuseRestoreOverOriginals(g, selected, nil, nil, nil, failing, result) || result.Code != ResultCodeRestoreWouldOverwriteOriginals {
		t.Fatalf("volume-root target, second pass failed: result %+v; want the overwrite reported", result)
	}
}

// An original the helper may not read does not refuse a restore whose
// destination is not there: a destination that does not exist cannot be
// the original, whatever the original's state.
func TestRefuseRestoreOverOriginals_DeniedOriginalAbsentDestination(t *testing.T) {
	denied := fmt.Errorf("stat: %w", fs.ErrPermission)
	g := newOriginalsGuard("/target")
	g.identity = newFakeIdentityCheck("/target", stylePOSIX, func(p string) (os.FileInfo, error) {
		switch {
		case p == "/target", p == "/":
			return fakeDirInfo(p), nil
		case strings.HasPrefix(p, "/target/"):
			return nil, fs.ErrNotExist
		default:
			return nil, denied
		}
	})
	selected := []SnapshotFile{{SourcePath: "/Users/a/Library/Mail/x"}}
	result := &RestoreResult{}
	if refuseRestoreOverOriginals(g, selected, nil, nil, nil, noteAll(g, selected, nil), result) {
		t.Fatalf("denied original, absent destination: refused with %+v; want the restore to go ahead", result)
	}
}

// With the destination there, a denied original fails closed, and the
// refusal says what to do before naming the first path it could not check.
func TestRefuseRestoreOverOriginals_DeniedOriginalExistingDestination(t *testing.T) {
	denied := &fs.PathError{Op: "stat", Path: "/Users/a/Library/Mail", Err: fs.ErrPermission}
	g := newOriginalsGuard("/target")
	g.identity = newFakeIdentityCheck("/target", stylePOSIX, func(p string) (os.FileInfo, error) {
		switch {
		case strings.HasPrefix(p, "/target"), p == "/", p == "/Users", p == "/Users/a", p == "/Users/a/Library":
			return fakeDirInfo(p), nil
		default:
			return nil, denied
		}
	})
	selected := []SnapshotFile{{SourcePath: "/Users/a/Library/Mail/x"}}
	result := &RestoreResult{}
	if !refuseRestoreOverOriginals(g, selected, nil, nil, nil, noteAll(g, selected, nil), result) || result.Code != ResultCodeRestoreOverwriteCheckFailed {
		t.Fatalf("denied original, existing destination: result %+v; want refused with %s", result, ResultCodeRestoreOverwriteCheckFailed)
	}
	msg := result.Error
	for _, want := range []string{"nothing was written", "new, empty folder", "Full Disk Access", "First path that could not be checked (original location): /Users/a/Library/Mail (permission denied)"} {
		if !strings.Contains(msg, want) {
			t.Errorf("refusal %q lacks %q", msg, want)
		}
	}
	if strings.Index(msg, "new, empty folder") > strings.Index(msg, "/Users/a/Library/Mail") {
		t.Errorf("refusal %q names the path before the advice: a cut at the server's limit would drop the advice", msg)
	}
	if strings.Count(msg, "/Users/a/Library/Mail") != 1 {
		t.Errorf("refusal %q repeats the path", msg)
	}
}

// Paths quoted in a refusal are capped, so the advice and the code reach
// the server whole however long the path.
func TestOverwriteRefusals_CapQuotedPaths(t *testing.T) {
	long := "/" + strings.Repeat("d/", 3000) + "x"
	checkFailed := overwriteCheckFailedRefusal("/target", &uncheckedPathError{what: "original location", path: long, err: fs.ErrPermission})
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
