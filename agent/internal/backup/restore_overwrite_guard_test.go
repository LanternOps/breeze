package backup

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// TestRestoreFromSnapshot_AlternateRootTargetKeepsOriginals reproduces #12638:
// a restore whose target is the volume root the files were backed up from
// rebuilds every original path, so it overwrote the live files.
func TestRestoreFromSnapshot_AlternateRootTargetKeepsOriginals(t *testing.T) {
	provider, snapshotID, original := setupOriginalTestSnapshot(t)

	result, err := RestoreFromSnapshot(provider, RestoreConfig{
		SnapshotID: snapshotID,
		TargetPath: volumeRootOf(original),
		WorkRoot:   t.TempDir(),
	}, nil)
	if err != nil {
		t.Fatalf("restore returned an error, want a result body: %v", err)
	}
	if got, _ := os.ReadFile(original); string(got) != "live" {
		t.Fatalf("original now holds %q: the restore overwrote it", got)
	}
	if result.Status != "failed" || result.Code != ResultCodeRestoreWouldOverwriteOriginals || result.FilesRestored != 0 {
		t.Errorf("result = %+v; want failed with %s", result, ResultCodeRestoreWouldOverwriteOriginals)
	}
}

// The control: a sub-folder target of the same volume restores beside the
// original and leaves it alone.
func TestRestoreFromSnapshot_SubfolderTargetRestores(t *testing.T) {
	provider, snapshotID, original := setupOriginalTestSnapshot(t)
	target := t.TempDir()

	result, err := RestoreFromSnapshot(provider, RestoreConfig{
		SnapshotID: snapshotID, TargetPath: target, WorkRoot: t.TempDir(),
	}, nil)
	if err != nil || result.Status != "completed" {
		t.Fatalf("restore = %+v, %v; want completed", result, err)
	}
	if got, _ := os.ReadFile(original); string(got) != "live" {
		t.Fatalf("original now holds %q", got)
	}
	if got, err := os.ReadFile(resolveTargetPath(target, original)); err != nil || string(got) != "backed up" {
		t.Fatalf("restored copy = %q, %v", got, err)
	}
}

func volumeRootOf(p string) string {
	return filepath.VolumeName(p) + string(filepath.Separator)
}

// setupRestoreTestSnapshotAt records each file under the absolute path given
// (content uploaded as is) and each directory entry, with nothing written at
// those paths.
func setupRestoreTestSnapshotAt(t *testing.T, files map[string]string, dirs []string) (*providers.LocalProvider, string) {
	t.Helper()
	ordered := make([][2]string, 0, len(files))
	for path, content := range files {
		ordered = append(ordered, [2]string{path, content})
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i][0] < ordered[j][0] })
	return setupRestoreTestSnapshotOrdered(t, ordered, dirs)
}

// setupRestoreTestSnapshotOrdered is setupRestoreTestSnapshotAt with the
// manifest's file entries in the order given ({path, content} pairs).
func setupRestoreTestSnapshotOrdered(t *testing.T, files [][2]string, dirs []string) (*providers.LocalProvider, string) {
	t.Helper()
	provider := privateTestLocalProvider(t, t.TempDir())
	snapshotID := "inplace-at-snap"
	prefix := filepath.Join("snapshots", snapshotID)
	now := time.Now().UTC()
	var entries []SnapshotFile
	for i, file := range files {
		path, content := file[0], file[1]
		src := filepath.Join(t.TempDir(), "content")
		if err := os.WriteFile(src, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		key := filepath.ToSlash(filepath.Join(prefix, "files", fmt.Sprintf("f%d.gz", i)))
		if err := provider.Upload(src, key); err != nil {
			t.Fatal(err)
		}
		entries = append(entries, SnapshotFile{SourcePath: path, BackupPath: key, Size: int64(len(content)), ModTime: now})
	}
	for _, d := range dirs {
		entries = append(entries, SnapshotFile{SourcePath: d, Kind: KindDir, ModTime: now})
	}
	uploadTestManifest(t, provider, prefix, Snapshot{ID: snapshotID, Timestamp: now, Files: entries, Size: totalSize(entries)})
	return provider, snapshotID
}

func uploadTestManifest(t *testing.T, provider *providers.LocalProvider, prefix string, snapshot Snapshot) {
	t.Helper()
	manifest, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	manifestTmp := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(manifestTmp, manifest, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := provider.Upload(manifestTmp, filepath.Join(prefix, "manifest.json")); err != nil {
		t.Fatal(err)
	}
}

// setupOriginalTestSnapshot backs up one live file, recorded under its real
// absolute path, and returns that path. The live file then holds "live"
// while the snapshot holds "backed up".
func setupOriginalTestSnapshot(t *testing.T) (*providers.LocalProvider, string, string) {
	t.Helper()
	provider := privateTestLocalProvider(t, t.TempDir())
	snapshotID := "inplace-snap"
	prefix := filepath.Join("snapshots", snapshotID)

	// The real path: macOS's /var is a symlink, which the restore refuses to
	// write through, and that would hide the overwrite.
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(dir, "docs", "testfile1.dat")
	if err := os.MkdirAll(filepath.Dir(original), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(original, []byte("backed up"), 0o644); err != nil {
		t.Fatal(err)
	}
	key := filepath.ToSlash(filepath.Join(prefix, "files", "testfile1.dat.gz"))
	if err := provider.Upload(original, key); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(original, []byte("live"), 0o644); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	files := []SnapshotFile{{SourcePath: original, BackupPath: key, Size: int64(len("backed up")), ModTime: now}}
	uploadTestManifest(t, provider, prefix, Snapshot{ID: snapshotID, Timestamp: now, Files: files, Size: totalSize(files)})
	return provider, snapshotID, original
}

// restoreDestinationKey decides "this destination is the original" in the
// recorded path's own style, whatever the host: every spelling of a volume
// root collides, a sub-folder never does, and a target of another style
// never names a location of the entry's style.
func TestRestoreDestinationKey_VolumeRootTargets(t *testing.T) {
	for _, tc := range []struct {
		target, source string
		want           bool
	}{
		// Windows, the volume the entry came from.
		{`D:\`, `D:\Users\a\test\testfile1.dat`, true},
		{`d:\`, `D:\Users\a\test\testfile1.dat`, true},
		{`D:`, `D:\Users\a\test\testfile1.dat`, true}, // the helper refuses a non-absolute target anyway
		{`D:/`, `D:\Users\a\test\testfile1.dat`, true},
		{`\\?\D:\`, `D:\Users\a\test\testfile1.dat`, true},
		{`\\.\D:\`, `D:\Users\a\test\testfile1.dat`, true},
		{`D:\.`, `D:\Users\a\x`, true},
		{`D:\Users\..`, `D:\Users\a\x`, true},
		{`D:\ `, `D:\Users\a\x`, true},      // Win32 drops a trailing space
		{`\\?\D:\ `, `D:\Users\a\x`, false}, // \\?\ does not: a folder named " "
		{`\\srv\share`, `\\srv\share\a\x`, true},
		{`\\SRV\Share\`, `\\srv\share\a\x`, true},
		{`\\?\UNC\srv\share\`, `\\srv\share\a\x`, true},
		{`D:\`, `\\?\D:\a\x`, true},
		// Windows, not the original.
		{`D:\restore`, `D:\Users\a\x`, false},
		{`D:\Restored\`, `D:\Users\a\x`, false},
		{`C:\`, `D:\Users\a\x`, false},
		{`\\srv\other`, `\\srv\share\a\x`, false},
		{`D:foo`, `D:\Users\a\x`, false},
		// POSIX.
		{`/`, `/home/a/x`, true},
		{`//`, `/home/a/x`, true},
		{`/.`, `/home/a/x`, true},
		{`/home/..`, `/home/a/x`, true},
		{`/restore`, `/home/a/x`, false},
		{`/home/a`, `/home/a/x`, false},
		// Mixed styles and relative entries never collide.
		{`/`, `C:\Users\a\x`, false},
		{`C:\`, `/home/a/x`, false},
		{`/`, `path_0/x`, false},
		{`C:\`, `path_0\x`, false},
	} {
		dest, original, ok := restoreDestinationKey(tc.target, tc.source)
		if got := ok && dest.String() == original.String(); got != tc.want {
			t.Errorf("target %q, entry %q: destination is the original = %v (dest %v, original %v), want %v", tc.target, tc.source, got, dest, original, tc.want)
		}
	}
}

// A target inside the backed-up tree collides when a nested copy of the tree
// was itself backed up: the destination of one entry is the original of
// another. A target inside the tree with no such copy does not.
func TestOverwritesOriginals_DestinationIsAnotherOriginal(t *testing.T) {
	const root = "/nonexistent-12638"
	example, count, err := overwritesOriginals(root+"/data", []string{
		root + "/data/x",                        // → .../data/nonexistent-12638/data/x
		root + "/data/nonexistent-12638/data/x", // that original
		root + "/other/y",
	})
	if err != nil || count != 1 || example != root+"/data/x" {
		t.Fatalf("overwritesOriginals = %q, %d, %v; want the one entry that lands on another original", example, count, err)
	}
	if _, count, err := overwritesOriginals(root+"/data", []string{root + "/data/x", root + "/other/y"}); err != nil || count != 0 {
		t.Fatalf("target inside the tree with no nested copy: count %d, %v; want 0", count, err)
	}
	if _, count, err := overwritesOriginals(`C:\data`, []string{`C:\data\x`, `c:\DATA\data\X`}); err != nil || count != 1 {
		t.Fatalf("Windows nested copy, other case: count %d, %v; want 1", count, err)
	}
}

// A target that is the original volume root under another name is caught by
// file identity: here a symlink to "/", and a target whose first directory
// is a link to the original one.
func TestOverwritesOriginals_AliasedTarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX path style; Windows aliases are covered by restore_overwrite_guard_windows_test.go")
	}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(dir, "docs", "x.txt")
	if err := os.MkdirAll(filepath.Dir(original), 0o755); err != nil {
		t.Fatal(err)
	}
	rootAlias := filepath.Join(t.TempDir(), "root")
	if err := os.Symlink("/", rootAlias); err != nil {
		t.Fatal(err)
	}
	if _, count, err := overwritesOriginals(rootAlias, []string{original}); err != nil || count != 1 {
		t.Fatalf("link to /: count %d, %v; want 1", count, err)
	}

	first, _, _ := strings.Cut(strings.TrimPrefix(original, "/"), "/")
	nested := t.TempDir()
	if err := os.Symlink("/"+first, filepath.Join(nested, first)); err != nil {
		t.Fatal(err)
	}
	if _, count, err := overwritesOriginals(nested, []string{original}); err != nil || count != 1 {
		t.Fatalf("target whose %q is a link to /%s: count %d, %v; want 1", first, first, count, err)
	}

	if _, count, err := overwritesOriginals(t.TempDir(), []string{original}); err != nil || count != 0 {
		t.Fatalf("plain new folder: count %d, %v; want 0", count, err)
	}
}

// In place is still available when asked for: the same root target with
// AllowOverwriteOriginals writes the snapshot's bytes back over the original.
func TestRestoreFromSnapshot_AllowOverwriteOriginalsRestoresInPlace(t *testing.T) {
	provider, snapshotID, original := setupOriginalTestSnapshot(t)
	result, err := RestoreFromSnapshot(provider, RestoreConfig{
		SnapshotID: snapshotID, TargetPath: volumeRootOf(original), WorkRoot: t.TempDir(), AllowOverwriteOriginals: true,
	}, nil)
	if err != nil || result.Status != "completed" {
		t.Fatalf("in-place restore = %+v, %v; want completed", result, err)
	}
	if got, _ := os.ReadFile(original); string(got) != "backed up" {
		t.Fatalf("original holds %q after an in-place restore, want the backed-up bytes", got)
	}
}

// The default (no target: the helper's staging folder) is never checked and
// never touches the original.
func TestRestoreFromSnapshot_StagingDefaultUnaffected(t *testing.T) {
	provider, snapshotID, original := setupOriginalTestSnapshot(t)
	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, WorkRoot: t.TempDir()}, nil)
	if err != nil || result.Status != "completed" {
		t.Fatalf("staging restore = %+v, %v; want completed", result, err)
	}
	if got, _ := os.ReadFile(original); string(got) != "live" {
		t.Fatalf("original now holds %q", got)
	}
}

// A refused restore writes nothing under the target: here the target is a
// folder inside the backed-up tree that held a backed-up nested copy, so the
// first entry's destination is the second entry's original.
func TestRestoreFromSnapshot_RefusalWritesNothing(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "target")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	first := filepath.Join(target, "a.txt")
	nested := resolveTargetPath(target, first) // where first would be restored
	provider, snapshotID := setupRestoreTestSnapshotAt(t, map[string]string{first: "one", nested: "two"}, []string{filepath.Join(target, "sub")})

	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: target, WorkRoot: t.TempDir()}, nil)
	if err != nil {
		t.Fatalf("restore returned an error, want a result body: %v", err)
	}
	if result.Status != "failed" || result.Code != ResultCodeRestoreWouldOverwriteOriginals || result.FilesRestored != 0 {
		t.Fatalf("result = %+v; want failed with %s and nothing restored", result, ResultCodeRestoreWouldOverwriteOriginals)
	}
	if !strings.Contains(result.Error, "nothing was written") || !strings.Contains(result.Error, first+" would overwrite "+nested) {
		t.Errorf("error %q should say why and name an affected entry", result.Error)
	}
	if result.StagingDir != "" {
		t.Errorf("staging dir %q created for a refused restore", result.StagingDir)
	}
	if entries, err := os.ReadDir(target); err != nil || len(entries) != 0 {
		t.Fatalf("target holds %v (%v) after a refused restore, want it untouched", entries, err)
	}
}

// Every kind of selected entry is checked, not only content files: a
// selection of only a directory, or only a junction, at its own volume root
// is refused too.
func TestRefuseRestoreOverOriginals_AllEntryKinds(t *testing.T) {
	for name, tc := range map[string]struct {
		dirs      []SnapshotFile
		links     []SnapshotFile
		junctions []SnapshotJunction
	}{
		"directory": {dirs: []SnapshotFile{{SourcePath: "/nonexistent-12638/d", Kind: KindDir}}},
		"symlink":   {links: []SnapshotFile{{SourcePath: "/nonexistent-12638/l", Kind: KindSymlink, LinkTarget: "x"}}},
		"junction":  {junctions: []SnapshotJunction{{SourcePath: `C:\Users\a\My Music`, Target: `C:\Users\a\Music`}}},
	} {
		target := "/"
		if len(tc.junctions) > 0 {
			target = `C:\`
		}
		result := &RestoreResult{}
		g := newOriginalsGuard(target)
		originals := noteAll(g, append(tc.dirs, tc.links...), tc.junctions)
		if !refuseRestoreOverOriginals(g, nil, tc.links, tc.dirs, tc.junctions, originals, result) || result.Code != ResultCodeRestoreWouldOverwriteOriginals {
			t.Errorf("%s at its own volume root: result %+v, want refused", name, result)
		}
	}
}

// A selective restore is checked against every original the snapshot holds,
// not only the selected ones: the selected entry's destination here is the
// original of an entry the operator did not select.
func TestRestoreFromSnapshot_UnselectedOriginalIsProtected(t *testing.T) {
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
	provider, snapshotID := setupRestoreTestSnapshotAt(t, map[string]string{first: "one", nested: "two"}, nil)

	result, err := RestoreFromSnapshot(provider, RestoreConfig{
		SnapshotID: snapshotID, TargetPath: target, WorkRoot: t.TempDir(), SelectedPaths: []string{first},
	}, nil)
	if err != nil || result.Code != ResultCodeRestoreWouldOverwriteOriginals {
		t.Fatalf("restore = %+v, %v; want refused with %s", result, err, ResultCodeRestoreWouldOverwriteOriginals)
	}
	if entries, _ := os.ReadDir(target); len(entries) != 0 {
		t.Fatalf("target holds %v after a refused restore", entries)
	}
}

// Identity verdicts are cached per original volume: C:\x and D:\x restore
// to the same destination directory, but only the one whose volume the
// target aliases is an overwrite. Here the target T:\ is D:\ by identity.
func TestDirIdentityCheck_CacheIsPerVolume(t *testing.T) {
	withWindowsVolumeName(t)
	id := map[string]string{"T:": "d", "C:": "c", "D:": "d"}
	c := newFakeIdentityCheck(`T:\`, styleWindows, func(p string) (os.FileInfo, error) {
		if v, ok := id[strings.TrimRight(p, `\/`)]; ok { // the host joins with its own separator
			return fakeDir{id: v}, nil
		}
		return nil, fs.ErrNotExist
	})
	if same, err := c.aliasesOriginal(`C:\f`); err != nil || same {
		t.Fatalf("C: entry: alias %v, %v; want distinct", same, err)
	}
	if same, err := c.aliasesOriginal(`D:\f`); err != nil || !same {
		t.Fatalf("D: entry after a C: entry at the same relative path: alias %v, %v; want the D: alias found", same, err)
	}
}

// A destination or original that cannot be examined fails the check closed,
// except where the error itself shows there is nothing there: does not
// exist, not a directory, a path too long to stat (past everything already
// compared), or, on Windows, a volume or share that cannot be reached (see
// restore_overwrite_unreachable_windows.go).
func TestDirIdentityCheck_StatErrorsFailClosed(t *testing.T) {
	denied := fmt.Errorf("access denied: %w", fs.ErrPermission)
	for name, stat := range map[string]func(string) (os.FileInfo, error){
		"destination": func(p string) (os.FileInfo, error) {
			if strings.HasPrefix(p, "/target") {
				return nil, denied
			}
			return fakeDirInfo(p), nil
		},
		"original": func(p string) (os.FileInfo, error) {
			if strings.HasPrefix(p, "/target") {
				return fakeDirInfo(p), nil
			}
			return nil, denied
		},
	} {
		c := newFakeIdentityCheck("/target", stylePOSIX, stat)
		if _, err := c.aliasesOriginal("/home/a/x"); !errors.Is(err, denied) {
			t.Errorf("%s unreadable: err %v, want it reported", name, err)
		}
	}
	c := newFakeIdentityCheck("/target", stylePOSIX, func(string) (os.FileInfo, error) { return nil, fs.ErrNotExist })
	if same, err := c.aliasesOriginal("/home/a/x"); err != nil || same {
		t.Errorf("nothing exists: alias %v, %v; want not an overwrite", same, err)
	}
	for _, err := range []error{fs.ErrNotExist, syscall.ENOTDIR, syscall.ENAMETOOLONG} {
		c := newFakeIdentityCheck("/target", stylePOSIX, func(p string) (os.FileInfo, error) {
			if strings.HasPrefix(p, "/target") {
				return fakeDirInfo(p), nil
			}
			return nil, err
		})
		if same, gotErr := c.aliasesOriginal("/home/a/x"); gotErr != nil || same {
			t.Errorf("original %v: alias %v, %v; want not an overwrite", err, same, gotErr)
		}
	}
	// Any other error leaves the question open: refuse.
	unknown := errors.New("input/output error")
	c = newFakeIdentityCheck("/target", stylePOSIX, func(p string) (os.FileInfo, error) {
		if strings.HasPrefix(p, "/target") {
			return fakeDirInfo(p), nil
		}
		return nil, unknown
	})
	if _, err := c.aliasesOriginal("/home/a/x"); !errors.Is(err, unknown) {
		t.Errorf("original %v: err %v, want it reported", unknown, err)
	}
}

// fakeDir is a directory whose identity is id.
type fakeDir struct{ id string }

func (d fakeDir) Name() string       { return d.id }
func (d fakeDir) Size() int64        { return 0 }
func (d fakeDir) Mode() os.FileMode  { return os.ModeDir | 0o755 }
func (d fakeDir) ModTime() time.Time { return time.Time{} }
func (d fakeDir) IsDir() bool        { return true }
func (d fakeDir) Sys() any           { return nil }

func fakeDirInfo(path string) os.FileInfo { return fakeDir{id: path} }

func newFakeIdentityCheck(target string, host pathStyle, stat func(string) (os.FileInfo, error)) *dirIdentityCheck {
	return &dirIdentityCheck{targetBase: target, hostStyle: host, stat: stat, lstat: stat, verdicts: map[string]dirVerdict{},
		sameFile: func(a, b os.FileInfo) bool { return a.(fakeDir).id == b.(fakeDir).id }}
}

// overwritesOriginals runs the guard over a snapshot whose entries are
// exactly the selected ones (test helper: the restore also notes the
// unselected entries while it decodes the manifest).
func overwritesOriginals(targetBase string, recorded []string) (example string, count int, err error) {
	g := newOriginalsGuard(targetBase)
	for _, p := range recorded {
		g.noteOriginal(p)
	}
	f := g.check(recorded, originalsOf(recorded))
	return f.entry, f.count, f.uncheckedErr
}

// noteAll notes every entry as the manifest decode would and returns them
// as the originals source the second pass streams.
func noteAll(g *originalsGuard, files []SnapshotFile, junctions []SnapshotJunction) originalSource {
	var recorded []string
	for _, f := range files {
		recorded = append(recorded, restoreSourcePath(f))
	}
	for _, j := range junctions {
		recorded = append(recorded, j.restorePath())
	}
	for _, p := range recorded {
		g.noteOriginal(p)
	}
	return originalsOf(recorded)
}

// A Windows VSS backup records the shadow-copy device path as SourcePath and
// the real path as OriginalPath: the guard must judge the real one, for
// files and junctions alike (#12638's own repro is such a snapshot).
func TestRefuseRestoreOverOriginals_VSSOriginalPath(t *testing.T) {
	file := SnapshotFile{SourcePath: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\Users\a\x.dat`, OriginalPath: `C:\Users\a\x.dat`}
	junction := SnapshotJunction{SourcePath: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\Users\a\My Music`, OriginalPath: `C:\Users\a\My Music`, Target: `C:\Users\a\Music`}
	for name, tc := range map[string]struct {
		files     []SnapshotFile
		junctions []SnapshotJunction
	}{
		"file":     {files: []SnapshotFile{file}},
		"junction": {junctions: []SnapshotJunction{junction}},
	} {
		g := newOriginalsGuard(`C:\`)
		originals := noteAll(g, tc.files, tc.junctions)
		result := &RestoreResult{}
		if !refuseRestoreOverOriginals(g, tc.files, nil, nil, tc.junctions, originals, result) || result.Code != ResultCodeRestoreWouldOverwriteOriginals {
			t.Errorf("VSS %s restored to C:\\: result %+v, want refused", name, result)
		}
	}
}

// When the check cannot finish, the restore is refused with its own code and
// a next step; a definite hit found alongside still wins the report.
func TestRefuseRestoreOverOriginals_CheckFailure(t *testing.T) {
	denied := fmt.Errorf("access denied: %w", fs.ErrPermission)
	g := newOriginalsGuard("/target")
	g.identity = newFakeIdentityCheck("/target", stylePOSIX, func(string) (os.FileInfo, error) { return nil, denied })
	g.identity.hostStyle = stylePOSIX
	result := &RestoreResult{}
	selected := []SnapshotFile{{SourcePath: "/home/a/x"}}
	if !refuseRestoreOverOriginals(g, selected, nil, nil, nil, noteAll(g, selected, nil), result) {
		t.Fatal("restore went ahead although the check could not finish")
	}
	if result.Status != "failed" || result.Code != ResultCodeRestoreOverwriteCheckFailed ||
		!strings.Contains(result.Error, "could not confirm") || !strings.Contains(result.Error, "new, empty folder") {
		t.Fatalf("result %+v; want failed with %s and a next step", result, ResultCodeRestoreOverwriteCheckFailed)
	}

	// The same unreadable identity, plus an entry that lexically lands on
	// another original: the definite hit is what is reported.
	g = newOriginalsGuard("/target")
	g.identity = newFakeIdentityCheck("/target", stylePOSIX, func(string) (os.FileInfo, error) { return nil, denied })
	originals := noteAll(g, []SnapshotFile{{SourcePath: "/home/a/y"}, {SourcePath: "/target/x"}, {SourcePath: "/target/target/x"}}, nil)
	result = &RestoreResult{}
	if !refuseRestoreOverOriginals(g, []SnapshotFile{{SourcePath: "/home/a/y"}, {SourcePath: "/target/x"}}, nil, nil, nil, originals, result) ||
		result.Code != ResultCodeRestoreWouldOverwriteOriginals || !strings.Contains(result.Error, "/target/x would overwrite /target/target/x") {
		t.Fatalf("result %+v; want the definite overwrite reported", result)
	}
}

// The restore notes every junction in the manifest as an original, so a
// file whose destination is a backed-up junction is refused too.
func TestRestoreFromSnapshot_JunctionOriginalIsProtected(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "target")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	first := filepath.Join(target, "a.txt")
	provider, snapshotID := setupRestoreTestSnapshotAt(t, map[string]string{first: "one"}, nil)
	// Re-upload the manifest with a junction recorded where first restores.
	prefix := filepath.Join("snapshots", snapshotID)
	snapshot, err := downloadManifest(provider, snapshotID, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	snapshot.Junctions = []SnapshotJunction{{SourcePath: resolveTargetPath(target, first), Target: `C:\x`}}
	uploadTestManifest(t, provider, prefix, *snapshot)

	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: target, WorkRoot: t.TempDir(), SelectedPaths: []string{first}}, nil)
	if err != nil || result.Code != ResultCodeRestoreWouldOverwriteOriginals {
		t.Fatalf("restore = %+v, %v; want refused", result, err)
	}
}

// Running the same restore again into a folder that already holds its
// restored absolute symlink is not an overwrite: the link resolves to the
// same directory as the original link, but the restore replaces the link by
// name and never writes through it.
func TestRestoreFromSnapshot_RerunWithAbsoluteSymlinkCompletes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX symlink entry")
	}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(dir, "home", "a", "data")
	if err := os.MkdirAll(data, 0o755); err != nil {
		t.Fatal(err)
	}
	// The live original link, as on the machine the backup came from.
	if err := os.Symlink(data, filepath.Join(dir, "home", "a", "cur")); err != nil {
		t.Fatal(err)
	}
	provider := privateTestLocalProvider(t, t.TempDir())
	const snapshotID = "symlink-rerun"
	prefix := filepath.Join("snapshots", snapshotID)
	src := filepath.Join(t.TempDir(), "content")
	if err := os.WriteFile(src, []byte("one"), 0o644); err != nil {
		t.Fatal(err)
	}
	key := filepath.ToSlash(filepath.Join(prefix, "files", "f.gz"))
	if err := provider.Upload(src, key); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	entries := []SnapshotFile{
		{SourcePath: filepath.Join(data, "f.txt"), BackupPath: key, Size: 3, ModTime: now},
		{SourcePath: filepath.Join(dir, "home", "a", "cur"), Kind: KindSymlink, LinkTarget: data, ModTime: now},
	}
	uploadTestManifest(t, provider, prefix, Snapshot{ID: snapshotID, Timestamp: now, Files: entries, Size: 3})

	target := t.TempDir()
	for run := 1; run <= 2; run++ {
		result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: target, WorkRoot: t.TempDir()}, nil)
		if err != nil || result.Status != "completed" {
			t.Fatalf("run %d = %+v, %v; want completed", run, result, err)
		}
	}
}

// A directory entry sitting exactly where an alias begins (a real directory
// at the destination that is the original, e.g. a bind mount of it) is an
// overwrite of the original directory's metadata.
func TestDirIdentityCheck_DirectoryEntryAtAlias(t *testing.T) {
	ids := map[string]string{"/target": "t", "/": "root", "/target/srv": "srv", "/srv": "srv"}
	c := newFakeIdentityCheck("/target", stylePOSIX, func(p string) (os.FileInfo, error) {
		if id, ok := ids[p]; ok {
			return fakeDir{id: id}, nil
		}
		return nil, fs.ErrNotExist
	})
	if same, err := c.aliasesOriginal("/srv"); err != nil || !same {
		t.Fatalf("directory entry /srv whose destination is /srv itself: alias %v, %v; want true", same, err)
	}
}
