package bmr

import (
	"context"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// destRecorder records every destination a restore asks it to download to
// and writes nothing, so a test may use manifest paths of either style
// without any of them being created on the host.
type destRecorder struct{ dests []string }

func (p *destRecorder) Download(_, dest string) error   { p.dests = append(p.dests, dest); return nil }
func (p *destRecorder) Upload(_, _ string) error        { return nil }
func (p *destRecorder) List(_ string) ([]string, error) { return nil, nil }
func (p *destRecorder) Delete(_ string) error           { return nil }

var _ providers.BackupProvider = (*destRecorder)(nil)

func contentManifest(paths ...string) *snapshotManifest {
	m := &snapshotManifest{ID: "snap-map"}
	for i, p := range paths {
		m.Files = append(m.Files, manifestFile{
			SourcePath: p,
			BackupPath: path.Join("snapshots", "snap-map", "files", fmt.Sprintf("f%d", i)),
			Size:       1,
		})
	}
	return m
}

// #12650: a folder mapping redirects every entry beneath it. Before the fix
// the lookup was an exact match on the whole path, so each of these wrote
// its file to the original path.
func TestRestoreFiles_FolderMappingRedirectsEntriesBeneathIt(t *testing.T) {
	posixSrc := filepath.Join(t.TempDir(), "home") // never created
	dst := t.TempDir()
	cases := []struct {
		name    string
		entry   string
		mapping string
		want    string
	}{
		{"host path", filepath.Join(posixSrc, "alice", "doc.txt"), posixSrc, filepath.Join(dst, "alice", "doc.txt")},
		{"host path, trailing separator", filepath.Join(posixSrc, "alice", "doc.txt"), posixSrc + string(filepath.Separator), filepath.Join(dst, "alice", "doc.txt")},
		{"windows path", `C:\Users\Alice\doc.txt`, `C:\Users`, filepath.Join(dst, "Alice", "doc.txt")},
		{"windows path, mixed case", `C:\Users\Alice\doc.txt`, `c:\USERS`, filepath.Join(dst, "Alice", "doc.txt")},
		{"windows path, forward slashes", `C:\Users\Alice\doc.txt`, `C:/Users`, filepath.Join(dst, "Alice", "doc.txt")},
		{"windows path, trailing separator", `C:\Users\Alice\doc.txt`, `C:\Users\`, filepath.Join(dst, "Alice", "doc.txt")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			provider := &destRecorder{}
			cfg := RecoveryConfig{TargetPaths: map[string]string{tc.mapping: dst}}
			_, _, warnings, failed, err := restoreFilesPlanned(context.Background(), contentManifest(tc.entry), cfg, provider)
			if err != nil || failed != 0 {
				t.Fatalf("restoreFiles: err=%v failed=%d warnings=%v", err, failed, warnings)
			}
			if len(provider.dests) != 1 || provider.dests[0] != tc.want {
				t.Fatalf("restored to %q, want %q", provider.dests, tc.want)
			}
		})
	}
}

// #12650: a mapping that matches nothing refuses the run before any write —
// including before the system-state phase, which writes to the live system
// ahead of the file phase.
func TestRunRecoveryContext_RefusesUnmatchedMappingBeforeAnyWrite(t *testing.T) {
	files := []fixtureFile{{source: "/data/a.txt", content: []byte("a")}}
	fx := newRecoveryFixture(t, "snap-unmatched", files)
	cfg := fx.config(nil)
	cfg.TargetPaths["/no/such/folder"] = filepath.Join(fx.targetRoot, "x")

	restorerBuilt := false
	orig := newRestorerFunc
	newRestorerFunc = func() Restorer { restorerBuilt = true; return &fakeStateRestorer{} }
	t.Cleanup(func() { newRestorerFunc = orig })
	fx.putObject(t, path.Join("snapshots", fx.snapshotID, "system-state", "manifest.json"), []byte(`{"schemaVersion":1,"platform":"linux","artifacts":[]}`))

	result, err := RunRecoveryContext(context.Background(), cfg, fx.provider)
	if err == nil {
		t.Fatalf("want a refusal, got result %+v", result)
	}
	if !strings.Contains(err.Error(), "/no/such/folder") {
		t.Fatalf("error %q does not name the unmatched mapping", err)
	}
	if result == nil || result.Status != "failed" || result.FilesRestored != 0 || !strings.Contains(result.Error, "/no/such/folder") {
		t.Fatalf("result = %+v, want failed with the mapping named and nothing restored", result)
	}
	if restorerBuilt {
		t.Fatal("the system-state phase ran before the refusal")
	}
	if _, statErr := os.Stat(fx.targets["/data/a.txt"]); statErr == nil {
		t.Fatal("the matched file was restored although another mapping matched nothing")
	}
}

// The symlink guard for a folder mapping walks from the mapping's target
// directory, whatever shape that target has (symlinkAncestorBase only
// derives a root from a target that ends in the original's own path).
func TestRestoreFiles_FolderMappingDoesNotWriteThroughSymlinkBelowTarget(t *testing.T) {
	src := filepath.Join(t.TempDir(), "home")
	dst, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(dst, "escape")); err != nil {
		t.Skipf("symlink: %v", err)
	}
	provider := &destRecorder{}
	cfg := RecoveryConfig{TargetPaths: map[string]string{src: dst}}
	_, _, warnings, failed, _ := restoreFilesPlanned(context.Background(), contentManifest(filepath.Join(src, "escape", "pwned")), cfg, provider)
	if failed != 1 || len(provider.dests) != 0 {
		t.Fatalf("failed=%d dests=%v, want the entry refused", failed, provider.dests)
	}
	if !strings.Contains(strings.Join(warnings, "\n"), "symlink") {
		t.Fatalf("warnings = %v, want one naming the symlink", warnings)
	}
}

// restoreFilesPlanned is restoreFiles with the plan RunRecoveryContext
// builds, for tests that drive the file phase directly.
func restoreFilesPlanned(ctx context.Context, manifest *snapshotManifest, cfg RecoveryConfig, provider providers.BackupProvider) (int, int64, []string, int, error) {
	plan, err := planTargetPaths(manifest, cfg.TargetPaths)
	if err != nil {
		return 0, 0, nil, 0, err
	}
	return restoreFiles(ctx, manifest, plan, cfg, provider)
}

// TestTargetPathMapResolve is the table for the one function that decides
// every destination. It runs on any host: the path style comes from the
// manifest entry, and the host separator is a parameter.
func TestTargetPathMapResolve(t *testing.T) {
	tests := []struct {
		name     string
		mappings map[string]string
		hostSep  byte
		entry    string
		want     string // "" with wantErr
		mapped   bool
		folder   string // expected folderRoot
		wantErr  bool
	}{
		// POSIX
		{name: "unmapped", mappings: map[string]string{"/home": "/r"}, hostSep: '/', entry: "/etc/hosts", want: "/etc/hosts"},
		{name: "exact file", mappings: map[string]string{"/home/a/f.txt": "/r/f.txt"}, hostSep: '/', entry: "/home/a/f.txt", want: "/r/f.txt", mapped: true},
		{name: "exact file keeps its literal target", mappings: map[string]string{"/home/a/f.txt": "/r/x/"}, hostSep: '/', entry: "/home/a/f.txt", want: "/r/x/", mapped: true},
		{name: "folder", mappings: map[string]string{"/home": "/restore/home"}, hostSep: '/', entry: "/home/alice/doc.txt", want: "/restore/home/alice/doc.txt", mapped: true, folder: "/restore/home"},
		{name: "folder entry itself", mappings: map[string]string{"/home": "/restore/home"}, hostSep: '/', entry: "/home", want: "/restore/home", mapped: true},
		{name: "folder entry itself, trailing separator on the source", mappings: map[string]string{"/home/": "/restore/home"}, hostSep: '/', entry: "/home", want: "/restore/home", mapped: true},
		{name: "component boundary", mappings: map[string]string{"/home": "/r"}, hostSep: '/', entry: "/homework/x", want: "/homework/x"},
		{name: "trailing separators", mappings: map[string]string{"/home/": "/r/"}, hostSep: '/', entry: "/home/a", want: "/r/a", mapped: true, folder: "/r/"},
		{name: "doubled separators", mappings: map[string]string{"//home//alice": "/r"}, hostSep: '/', entry: "/home/alice//doc", want: "/r/doc", mapped: true, folder: "/r"},
		{name: "posix is case sensitive", mappings: map[string]string{"/Home": "/r"}, hostSep: '/', entry: "/home/a", want: "/home/a"},
		{name: "root mapping", mappings: map[string]string{"/": "/mnt/restore"}, hostSep: '/', entry: "/etc/hosts", want: "/mnt/restore/etc/hosts", mapped: true, folder: "/mnt/restore"},
		{name: "folder target is the root", mappings: map[string]string{"/home": "/"}, hostSep: '/', entry: "/home/a", want: "/a", mapped: true, folder: "/"},
		{name: "longest source wins", mappings: map[string]string{"/home": "/r1", "/home/alice": "/r2"}, hostSep: '/', entry: "/home/alice/doc", want: "/r2/doc", mapped: true, folder: "/r2"},
		{name: "exact beats a folder", mappings: map[string]string{"/home": "/r1", "/home/alice/doc": "/r2/doc"}, hostSep: '/', entry: "/home/alice/doc", want: "/r2/doc", mapped: true},
		{name: "backslash is a posix name character", mappings: map[string]string{"/home": "/r"}, hostSep: '/', entry: `/home/a\b`, want: `/r/a\b`, mapped: true, folder: "/r"},
		{name: "dot component never prefix-matches", mappings: map[string]string{"/home": "/r"}, hostSep: '/', entry: "/home/../etc/passwd", wantErr: true},
		{name: "dot component without folder mappings is untouched", mappings: map[string]string{"/home/./x": "/r/x"}, hostSep: '/', entry: "/a/../b", want: "/a/../b"},
		{name: "relative entry", mappings: map[string]string{"data": "/r"}, hostSep: '/', entry: "data/x", want: "/r/x", mapped: true, folder: "/r"},
		{name: "posix name with a backslash on a windows host", mappings: map[string]string{"/home": `C:\r`}, hostSep: '\\', entry: `/home/..\..\evil`, wantErr: true},

		// Windows-style manifest entries, restored on a Linux host
		{name: "windows folder", mappings: map[string]string{`C:\Users`: "/mnt/users"}, hostSep: '/', entry: `C:\Users\Alice\doc.txt`, want: "/mnt/users/Alice/doc.txt", mapped: true, folder: "/mnt/users"},
		{name: "windows mixed case keeps the entry's spelling", mappings: map[string]string{`c:\USERS\alice`: "/mnt/a"}, hostSep: '/', entry: `C:\Users\Alice\Doc.TXT`, want: "/mnt/a/Doc.TXT", mapped: true, folder: "/mnt/a"},
		{name: "windows forward slashes in the source", mappings: map[string]string{`C:/Users/`: "/mnt/users"}, hostSep: '/', entry: `C:\Users\Alice\doc.txt`, want: "/mnt/users/Alice/doc.txt", mapped: true, folder: "/mnt/users"},
		{name: "windows forward slashes in the entry", mappings: map[string]string{`C:\Users`: "/mnt/users"}, hostSep: '/', entry: `C:/Users/Alice/doc.txt`, want: "/mnt/users/Alice/doc.txt", mapped: true, folder: "/mnt/users"},
		{name: "windows component boundary", mappings: map[string]string{`C:\Users`: "/r"}, hostSep: '/', entry: `C:\UsersData\x`, want: `C:\UsersData\x`},
		{name: "windows drive differs", mappings: map[string]string{`D:\Users`: "/r"}, hostSep: '/', entry: `C:\Users\x`, want: `C:\Users\x`},
		{name: "windows drive root", mappings: map[string]string{`C:\`: "/mnt/c"}, hostSep: '/', entry: `C:\Windows\win.ini`, want: "/mnt/c/Windows/win.ini", mapped: true, folder: "/mnt/c"},
		{name: "windows bare drive", mappings: map[string]string{`c:`: "/mnt/c"}, hostSep: '/', entry: `C:\x`, want: "/mnt/c/x", mapped: true, folder: "/mnt/c"},
		{name: "windows namespace prefix on the entry", mappings: map[string]string{`C:\Users`: "/r"}, hostSep: '/', entry: `\\?\C:\Users\a`, want: "/r/a", mapped: true, folder: "/r"},
		{name: "windows namespace UNC entry", mappings: map[string]string{`\\srv\share`: "/r"}, hostSep: '/', entry: `\\?\UNC\srv\share\x`, want: "/r/x", mapped: true, folder: "/r"},
		{name: "windows namespace prefix on the source", mappings: map[string]string{`\\?\C:\Users`: "/r"}, hostSep: '/', entry: `C:\Users\a`, want: "/r/a", mapped: true, folder: "/r"},
		{name: "windows device namespace entry", mappings: map[string]string{`C:\Users`: "/r"}, hostSep: '/', entry: `\\.\C:\Users\a`, want: "/r/a", mapped: true, folder: "/r"},
		{name: "windows UNC", mappings: map[string]string{`\\srv\share\dept`: "/r"}, hostSep: '/', entry: `\\SRV\Share\Dept\f.txt`, want: "/r/f.txt", mapped: true, folder: "/r"},
		{name: "windows dot component", mappings: map[string]string{`C:\Users`: "/r"}, hostSep: '/', entry: `C:\Users\..\Windows\x`, wantErr: true},
		{name: "windows source does not match a posix entry", mappings: map[string]string{`C:\home`: "/r"}, hostSep: '/', entry: "/home/a", want: "/home/a"},
		{name: "posix source does not match a windows entry", mappings: map[string]string{"/Users": "/r"}, hostSep: '/', entry: `C:\Users\a`, want: `C:\Users\a`},

		// Windows-style manifest entries, restored on a Windows host
		{name: "windows host folder", mappings: map[string]string{`C:\Users`: `C:\Restored\Users`}, hostSep: '\\', entry: `C:\Users\Alice\doc.txt`, want: `C:\Restored\Users\Alice\doc.txt`, mapped: true, folder: `C:\Restored\Users`},
		{name: "windows host folder, trailing separator on the target", mappings: map[string]string{`C:\Users`: `D:\Restored\`}, hostSep: '\\', entry: `C:\Users\Alice\doc.txt`, want: `D:\Restored\Alice\doc.txt`, mapped: true, folder: `D:\Restored\`},
		{name: "windows host drive-root target", mappings: map[string]string{`C:\Users`: `D:\`}, hostSep: '\\', entry: `C:\Users\a`, want: `D:\a`, mapped: true, folder: `D:\`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m, err := newTargetPathMap(tt.mappings, tt.hostSep)
			if err != nil {
				t.Fatalf("newTargetPathMap: %v", err)
			}
			got, err := m.resolve(tt.entry)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("resolve(%q) = %+v, want an error", tt.entry, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolve(%q): %v", tt.entry, err)
			}
			if got.path != tt.want || got.mapped != tt.mapped || got.folderRoot != tt.folder {
				t.Fatalf("resolve(%q) = {path:%q mapped:%v folder:%q}, want {path:%q mapped:%v folder:%q}",
					tt.entry, got.path, got.mapped, got.folderRoot, tt.want, tt.mapped, tt.folder)
			}
		})
	}
}

func TestNewTargetPathMap_RefusesOneSourceWithTwoTargets(t *testing.T) {
	if _, err := newTargetPathMap(map[string]string{`C:\Users`: "/a", `c:/users/`: "/b"}, '/'); err == nil {
		t.Fatal("two spellings of one source with different targets must be refused")
	}
	if _, err := newTargetPathMap(map[string]string{"/home": "/a", "/home/": "/a"}, '/'); err != nil {
		t.Fatalf("two spellings with the same target are one mapping: %v", err)
	}
}

func absPosix(p string) bool { return strings.HasPrefix(p, "/") }

func TestPlanTargetPaths(t *testing.T) {
	dir := func(p string) manifestFile { return manifestFile{SourcePath: p, Kind: "dir"} }
	file := func(p string) manifestFile { return manifestFile{SourcePath: p, BackupPath: "k/" + p, Size: 1} }
	winAbs := func(p string) bool { return pathStyleOf(p) == windowsPathStyle }
	tests := []struct {
		name     string
		files    []manifestFile
		mappings map[string]string
		errHas   []string // empty = the plan is accepted
		hostSep  byte     // default '/'
		isAbs    func(string) bool
	}{
		{name: "no mappings", files: []manifestFile{file("/a")}},
		{name: "every mapping matched", files: []manifestFile{file("/home/a"), file("/etc/x")}, mappings: map[string]string{"/home": "/r/home", "/etc/x": "/r/x"}},
		{name: "unmatched folder", files: []manifestFile{file("/home/a")}, mappings: map[string]string{"/home": "/r", "/srv": "/r2"}, errHas: []string{`"/srv"`, "matched no file", "nothing was restored"}},
		{name: "unmatched exact file", files: []manifestFile{file("/home/a")}, mappings: map[string]string{"/home/b": "/r/b"}, errHas: []string{`"/home/b"`}},
		{name: "empty manifest", mappings: map[string]string{"/home": "/r"}, errHas: []string{`"/home"`}},
		{name: "a shadowed mapping still covers its entries", files: []manifestFile{file("/home/alice/a")}, mappings: map[string]string{"/home": "/r1", "/home/alice": "/r2"}},
		{name: "a mapping covering only a refused entry counts as matched", files: []manifestFile{file(`/home/a\b`)}, mappings: map[string]string{"/home": `D:\r`}, hostSep: '\\', isAbs: winAbs},
		{name: "empty target", files: []manifestFile{file("/home/a")}, mappings: map[string]string{"/home": ""}, errHas: []string{"non-empty source and target"}},
		{name: "blank source", files: []manifestFile{file("/home/a")}, mappings: map[string]string{" ": "/r"}, errHas: []string{"non-empty source and target"}},
		{name: "windows host: names differing only in case collide", files: []manifestFile{file("/home/a"), file("/srv/A")}, mappings: map[string]string{"/home": `C:\r`, "/srv": `C:\r`}, hostSep: '\\', isAbs: winAbs, errHas: []string{"would both be restored"}},
		{name: "windows host: two drives merged collide", files: []manifestFile{file(`C:\Users\a\f`), file(`D:\Data\A\F`)}, mappings: map[string]string{`C:\Users`: `E:\r`, `D:\Data`: `E:\r`}, hostSep: '\\', isAbs: winAbs, errHas: []string{"would both be restored"}},
		{name: "shared subdirectory of two merged folders", files: []manifestFile{dir("/home/x"), dir("/srv/x"), file("/home/x/a"), file("/srv/x/b")}, mappings: map[string]string{"/home": "/r", "/srv": "/r"}},
		{name: "relative folder target", files: []manifestFile{file("/home/a")}, mappings: map[string]string{"/home": "restore"}, errHas: []string{`"restore"`, "not an absolute path"}},
		{name: "relative exact target keeps working", files: []manifestFile{file("/home/a")}, mappings: map[string]string{"/home/a": "restore/a"}},
		{name: "folder mapping lands two entries on one path", files: []manifestFile{file("/home/a"), file("/srv/a")}, mappings: map[string]string{"/home": "/r", "/srv": "/r"}, errHas: []string{`"/home/a"`, `"/srv/a"`, "/r/a"}},
		{name: "folder mapping onto an unmapped entry", files: []manifestFile{file("/home/a"), file("/etc/a")}, mappings: map[string]string{"/home": "/etc"}, errHas: []string{"/etc/a"}},
		{name: "two folders merged into one directory", files: []manifestFile{dir("/home"), dir("/srv"), file("/home/a"), file("/srv/b")}, mappings: map[string]string{"/home": "/r", "/srv": "/r"}},
		{name: "the same path listed twice", files: []manifestFile{file("/home/a"), file("/home/a")}, mappings: map[string]string{"/home": "/r"}},
		{name: "exact-only collisions are left as before", files: []manifestFile{file("/a"), file("/b")}, mappings: map[string]string{"/a": "/r/x", "/b": "/r/x"}},
		{name: "names at most ten mappings", files: []manifestFile{file("/a")}, mappings: func() map[string]string {
			m := map[string]string{"/a": "/r/a"}
			for i := range 12 {
				m[fmt.Sprintf("/none%02d", i)] = "/r"
			}
			return m
		}(), errHas: []string{`"/none09"`, "and 2 more"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sep, isAbs := tt.hostSep, tt.isAbs
			if sep == 0 {
				sep, isAbs = '/', absPosix
			}
			_, err := planTargetPathsFor(&snapshotManifest{Files: tt.files}, tt.mappings, sep, isAbs)
			if len(tt.errHas) == 0 {
				if err != nil {
					t.Fatalf("plan refused: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("plan accepted, want a refusal containing %q", tt.errHas)
			}
			for _, s := range tt.errHas {
				if !strings.Contains(err.Error(), s) {
					t.Fatalf("error %q does not contain %q", err, s)
				}
			}
		})
	}
}

// A manifest that maps a symlink entry and also an entry beneath it must
// not get that second entry written through the link — whether the link was
// created earlier in this run or by an interrupted earlier run. The
// filesystem walk cannot see it here: the second entry's mapping target
// itself lies below the link, and the walk starts at that target.
func TestRestoreFiles_FolderMappingRefusesEntryBelowMappedSymlink(t *testing.T) {
	home, srv := filepath.Join(t.TempDir(), "home"), filepath.Join(t.TempDir(), "srv")
	dst, outside := t.TempDir(), t.TempDir()
	manifest := contentManifest(filepath.Join(srv, "pwned"))
	manifest.Files = append([]manifestFile{{SourcePath: filepath.Join(home, "link"), Kind: "symlink", LinkTarget: outside}}, manifest.Files...)
	// The link is recorded, not created, so this runs where creating one
	// needs a privilege.
	origSymlink := symlinkFile
	symlinkFile = func(_, _ string) error { return nil }
	t.Cleanup(func() { symlinkFile = origSymlink })
	provider := &destRecorder{}
	cfg := RecoveryConfig{TargetPaths: map[string]string{home: dst, srv: filepath.Join(dst, "link", "x")}}
	_, _, warnings, failed, _ := restoreFilesPlanned(context.Background(), manifest, cfg, provider)
	if failed != 1 || len(provider.dests) != 0 {
		t.Fatalf("failed=%d dests=%v warnings=%v, want the entry below the link refused", failed, provider.dests, warnings)
	}
	if !strings.Contains(strings.Join(warnings, "\n"), "restored by this recovery") {
		t.Fatalf("warnings = %v", warnings)
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("something was written through the link: %v", entries)
	}
}

// A folder-mapped file is never written through a symlink already sitting
// at its destination.
func TestRestoreFiles_FolderMappingRefusesSymlinkAtDestination(t *testing.T) {
	src := filepath.Join(t.TempDir(), "home")
	dst, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(filepath.Join(outside, "victim"), filepath.Join(dst, "doc.txt")); err != nil {
		t.Skipf("symlink: %v", err)
	}
	provider := &destRecorder{}
	cfg := RecoveryConfig{TargetPaths: map[string]string{src: dst}}
	_, _, warnings, failed, _ := restoreFilesPlanned(context.Background(), contentManifest(filepath.Join(src, "doc.txt")), cfg, provider)
	if failed != 1 || len(provider.dests) != 0 {
		t.Fatalf("failed=%d dests=%v warnings=%v, want the write refused", failed, provider.dests, warnings)
	}
}

// End to end through RunRecoveryContext with real objects, in both the
// unattested and the attested (staged) file paths.
func TestRunRecoveryContext_FolderMappingRestoresUnderTarget(t *testing.T) {
	for _, attested := range []bool{false, true} {
		t.Run(fmt.Sprintf("attested=%v", attested), func(t *testing.T) {
			src := filepath.ToSlash(filepath.Join(t.TempDir(), "data")) // never created
			fx := newRecoveryFixture(t, "snap-folder", []fixtureFile{
				{source: src + "/a.txt", content: []byte("a")},
				{source: src + "/sub/b.txt", content: []byte("bb")},
			})
			cfg := fx.config(nil)
			if attested {
				cfg = fx.config(attestedExpectation(t, fx.snapshotID, fx.manifestBytes))
			}
			restored := filepath.Join(fx.targetRoot, "restored")
			cfg.TargetPaths = map[string]string{filepath.FromSlash(src): restored}
			if strings.Contains(src, ":") {
				// Windows: manifest paths use the host's own spelling.
				cfg.TargetPaths = map[string]string{src: restored}
			}
			orig := newRestorerFunc
			newRestorerFunc = func() Restorer { return &fakeStateRestorer{} }
			t.Cleanup(func() { newRestorerFunc = orig })

			result, err := RunRecoveryContext(context.Background(), cfg, fx.provider)
			if err != nil || result.FilesRestored != 2 || result.FailedFiles != 0 {
				t.Fatalf("result=%+v err=%v", result, err)
			}
			for rel, want := range map[string]string{"a.txt": "a", filepath.Join("sub", "b.txt"): "bb"} {
				got, readErr := os.ReadFile(filepath.Join(restored, rel))
				if readErr != nil || string(got) != want {
					t.Fatalf("%s: %q, %v", rel, got, readErr)
				}
			}
			if _, statErr := os.Stat(filepath.FromSlash(src)); statErr == nil {
				t.Fatal("something was restored at the original path")
			}
		})
	}
}

// planTargetPaths itself checks folder targets with this machine's notion of
// an absolute path.
func TestPlanTargetPaths_RefusesRelativeFolderTargetOnThisHost(t *testing.T) {
	src := filepath.Join(t.TempDir(), "home")
	_, err := planTargetPaths(contentManifest(filepath.Join(src, "a")), map[string]string{src: "restore"})
	if err == nil || !strings.Contains(err.Error(), "not an absolute path") {
		t.Fatalf("err = %v, want a relative-target refusal", err)
	}
}

// An entry the resolver refuses is reported as a failed file and never
// falls back to its original path.
func TestRestoreFiles_RefusedEntryIsNotRestoredInPlace(t *testing.T) {
	src := filepath.Join(t.TempDir(), "home")
	dst := t.TempDir()
	sep := string(filepath.Separator)
	escaping := src + sep + ".." + sep + "etc" + sep + "x" // not cleaned on purpose
	provider := &destRecorder{}
	cfg := RecoveryConfig{TargetPaths: map[string]string{src: dst}}
	_, _, warnings, failed, _ := restoreFilesPlanned(context.Background(), contentManifest(escaping, filepath.Join(src, "ok")), cfg, provider)
	if failed != 1 || len(provider.dests) != 1 || provider.dests[0] != filepath.Join(dst, "ok") {
		t.Fatalf("failed=%d dests=%v warnings=%v, want only the clean entry restored", failed, provider.dests, warnings)
	}
	if !strings.Contains(strings.Join(warnings, "\n"), "restore refused") {
		t.Fatalf("warnings = %v", warnings)
	}
}

// On a Windows host a folder-mapped destination still goes through the
// stream/alias name refusal.
func TestRestoreFiles_FolderMappingWindowsHostRefusesStreamNames(t *testing.T) {
	withRecoverHost(t, "windows")
	src := filepath.Join(t.TempDir(), "home")
	dst := t.TempDir()
	provider := &destRecorder{}
	cfg := RecoveryConfig{TargetPaths: map[string]string{src: dst}}
	_, _, warnings, failed, _ := restoreFilesPlanned(context.Background(), contentManifest(filepath.Join(src, "a:stream"), filepath.Join(src, "trailing.")), cfg, provider)
	if failed != 2 || len(provider.dests) != 0 {
		t.Fatalf("failed=%d dests=%v, want both refused", failed, provider.dests)
	}
	if !strings.Contains(strings.Join(warnings, "\n"), "invalid_windows_name") {
		t.Fatalf("warnings = %v", warnings)
	}
}
