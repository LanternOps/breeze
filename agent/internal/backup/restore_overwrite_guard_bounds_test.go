package backup

import (
	"errors"
	"fmt"
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
