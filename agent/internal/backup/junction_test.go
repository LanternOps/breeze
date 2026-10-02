package backup

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/securefs"
)

// The reparse parser seam (#7325): the buffer securefs writes for a restored
// junction must read back, through the same parser the collector uses, as
// that junction and target. This is the round trip a Windows lab run proves
// end to end; here it is proved byte for byte on every platform.
func TestParseReparseBuffer_RoundTripsRestoredJunction(t *testing.T) {
	for _, target := range []string{`C:\Users\a\Music`, `D:\`, `E:\Shared Data\Ünïcode`} {
		buf, err := securefs.JunctionReparseBuffer(target)
		if err != nil {
			t.Fatalf("JunctionReparseBuffer(%q): %v", target, err)
		}
		tag, kind, got, err := parseReparseBuffer(buf)
		if err != nil {
			t.Fatalf("parseReparseBuffer: %v", err)
		}
		if tag != ioReparseTagMountPoint || kind != reparseKindJunction || got != target {
			t.Fatalf("round trip of %q gave tag=%#x kind=%q target=%q", target, tag, kind, got)
		}
	}
}

// The substitute name is what the filesystem resolves; the print name is
// display text and may say anything. The captured target must be the former.
func TestParseReparseBuffer_JunctionTargetIsTheSubstituteName(t *testing.T) {
	_, kind, target, err := parseReparseBuffer(mountPointBuffer(`\??\C:\Real\Target`, `C:\Decoy`))
	if err != nil {
		t.Fatal(err)
	}
	if kind != reparseKindJunction || target != `C:\Real\Target` {
		t.Fatalf("kind=%q target=%q, want the substitute name C:\\Real\\Target", kind, target)
	}
}

func TestJunctionRestoreTarget(t *testing.T) {
	cases := []struct {
		name       string
		targetBase string
		source     string
		target     string
		asCaptured bool
		want       string
		rewritten  bool
		wantErr    bool
	}{
		{name: "in place keeps the target", targetBase: `C:\`, source: `C:\Users\a\My Music`, target: `C:\Users\a\Music`, want: `C:\Users\a\Music`},
		{name: "in place, lower-case base", targetBase: `c:\`, source: `C:\Users\a\My Music`, target: `C:\Users\a\Music`, want: `C:\Users\a\Music`},
		{name: "in place keeps a cross-volume target", targetBase: `C:\`, source: `C:\Data`, target: `D:\Data`, want: `D:\Data`},
		{name: "alternate location rewrites under the restore root", targetBase: `D:\restore`, source: `C:\Users\a\My Music`, target: `C:\Users\a\Music`, want: `D:\restore\Users\a\Music`, rewritten: true},
		{name: "alternate location, trailing separator", targetBase: `D:\restore\`, source: `C:\Users\a\My Music`, target: `C:\Users\a\Music`, want: `D:\restore\Users\a\Music`, rewritten: true},
		{name: "alternate location, volume-root target", targetBase: `D:\restore`, source: `C:\Users\a\x`, target: `C:\`, want: `D:\restore`, rewritten: true},
		{name: "alternate volume root, volume-root target", targetBase: `D:\`, source: `C:\Users\a\x`, target: `C:\`, want: `D:\`, rewritten: true},
		{name: "alternate volume root", targetBase: `D:\`, source: `C:\Users\a\My Music`, target: `C:\Users\a\Music`, want: `D:\Users\a\Music`, rewritten: true},
		{name: "alternate location, volume letters differ only in case", targetBase: `D:\restore`, source: `c:\Users\a\x`, target: `C:\Users\b`, want: `D:\restore\Users\b`, rewritten: true},
		{name: "alternate location refuses a cross-volume target", targetBase: `D:\restore`, source: `C:\Data`, target: `E:\Data`, wantErr: true},
		{name: "alternate location refuses a target that climbs out", targetBase: `D:\restore`, source: `C:\Users\a\x`, target: `C:\Users\..\..\Windows`, wantErr: true},
		{name: "refuses a non-drive target", targetBase: `C:\`, source: `C:\x`, target: `\\server\share`, wantErr: true},
		{name: "refuses a volume GUID target", targetBase: `C:\`, source: `C:\x`, target: `\\?\Volume{0b6a2c5e-0000-0000-0000-100000000000}\`, wantErr: true},
		{name: "refuses a source with no drive on an alternate restore", targetBase: `D:\restore`, source: `path_0\x`, target: `C:\x`, wantErr: true},
		{name: "refuses a non-drive restore root", targetBase: `\\server\share\restore`, source: `C:\x`, target: `C:\y`, wantErr: true},
		{name: "rebuild keeps the target as captured", targetBase: `\\?\Volume{0b6a2c5e-0000-0000-0000-100000000000}\`, source: `C:\Users\a\My Music`, target: `C:\Users\a\Music`, asCaptured: true, want: `C:\Users\a\Music`},
		{name: "rebuild still refuses an unsafe target", targetBase: `W:\`, source: `C:\x`, target: `C:\a\..\b`, asCaptured: true, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, rewritten, err := junctionRestoreTarget(tc.targetBase, tc.source, tc.target, tc.asCaptured)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("got %q, want a refusal", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected refusal: %v", err)
			}
			if got != tc.want || rewritten != tc.rewritten {
				t.Fatalf("got (%q, rewritten=%v), want (%q, rewritten=%v)", got, rewritten, tc.want, tc.rewritten)
			}
		})
	}
}

type junctionCall struct {
	base, relative, target string
	winAttrs               uint32
}

// stubJunctionInstall replaces the securefs calls the junction pass makes, so
// the pass can be driven on a host that has no junctions.
func stubJunctionInstall(t *testing.T, installErr error, reparseAlong func(base, relative string) error) *[]junctionCall {
	t.Helper()
	var calls []junctionCall
	origInstall, origAlong := installJunction, ensureNoReparsePointsAlong
	installJunction = func(base, relative, target string, winAttrs uint32) ([]error, error) {
		calls = append(calls, junctionCall{base, relative, target, winAttrs})
		return nil, installErr
	}
	if reparseAlong == nil {
		reparseAlong = func(string, string) error { return nil }
	}
	ensureNoReparsePointsAlong = reparseAlong
	origSupported := junctionsSupported
	junctionsSupported = true
	t.Cleanup(func() {
		installJunction, ensureNoReparsePointsAlong, junctionsSupported = origInstall, origAlong, origSupported
	})
	return &calls
}

func TestRestoreJunctions_AlternateLocation(t *testing.T) {
	calls := stubJunctionInstall(t, nil, nil)
	var along []string
	ensureNoReparsePointsAlong = func(base, relative string) error {
		along = append(along, base+"|"+relative)
		return nil
	}
	result := &RestoreResult{}
	restoreJunctions(`D:\restore`, []SnapshotJunction{
		{SourcePath: `C:\Users\a\My Music`, Target: `C:\Users\a\Music`, WinAttrs: 0x6},
		{SourcePath: `C:\Data\Elsewhere`, Target: `E:\Elsewhere`},
		{SourcePath: `C:\Users\a\Escape`, Target: `C:\Users\..\..\Windows`},
	}, false, nil, result)

	if len(*calls) != 1 {
		t.Fatalf("only the contained junction may be created, got %+v", *calls)
	}
	c := (*calls)[0]
	// Placed exactly where every other entry from that path is placed
	// (restoreRelativePath strips the drive on Windows).
	wantRel, _ := restoreRelativePath(`C:\Users\a\My Music`)
	if c.base != `D:\restore` || c.relative != wantRel || c.target != `D:\restore\Users\a\Music` || c.winAttrs != 0x6 {
		t.Fatalf("install call = %+v", c)
	}
	if len(along) != 1 || along[0] != `D:\restore|Users\a\Music` {
		t.Fatalf("a rewritten target must be checked for reparse points along it, got %v", along)
	}
	// A valid target on another volume is a policy refusal (warning); a
	// recorded target that climbs out with ".." is an invalid entry (failed).
	if result.FilesRestored != 1 || result.FilesFailed != 1 || len(result.FailedFiles) != 1 || result.FailedFiles[0] != `C:\Users\a\Escape` {
		t.Fatalf("result = %+v", result)
	}
	joined := strings.Join(result.Warnings, "\n")
	if !strings.Contains(joined, "junction C:\\Data\\Elsewhere not recreated") {
		t.Errorf("missing refusal warning for the cross-volume junction:\n%s", joined)
	}
}

// Restoring to the original location keeps every target verbatim and never
// needs the containment walk: the target is the original.
func TestRestoreJunctions_InPlaceKeepsTargets(t *testing.T) {
	calls := stubJunctionInstall(t, nil, func(string, string) error {
		t.Fatal("an in-place restore must not rewrite or walk the target")
		return nil
	})
	result := &RestoreResult{}
	restoreJunctions(`C:\`, []SnapshotJunction{
		{SourcePath: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy3\Users\a\My Music`, OriginalPath: `C:\Users\a\My Music`, Target: `C:\Users\a\Music`},
		{SourcePath: `C:\Data`, Target: `D:\Data`},
	}, false, nil, result)
	wantRel, _ := restoreRelativePath(`C:\Users\a\My Music`)
	if len(*calls) != 2 || (*calls)[0].target != `C:\Users\a\Music` || (*calls)[0].relative != wantRel || (*calls)[1].target != `D:\Data` {
		t.Fatalf("install calls = %+v", *calls)
	}
	if result.FilesRestored != 2 || len(result.Warnings) != 0 {
		t.Fatalf("result = %+v", result)
	}
}

func TestRestoreJunctions_ReparseAlongTargetIsRefused(t *testing.T) {
	calls := stubJunctionInstall(t, nil, func(string, string) error {
		return errors.New(`path component "a" is a reparse point`)
	})
	result := &RestoreResult{}
	restoreJunctions(`D:\restore`, []SnapshotJunction{{SourcePath: `C:\Users\a\My Music`, Target: `C:\Users\a\Music`}}, false, nil, result)
	if len(*calls) != 0 {
		t.Fatalf("a target that resolves through a reparse point must not get a junction, got %+v", *calls)
	}
	if result.FilesRestored != 0 || result.FilesFailed != 0 || len(result.Warnings) != 1 ||
		!strings.Contains(result.Warnings[0], "resolves through a link") {
		t.Fatalf("result = %+v", result)
	}
}

// A recorded target that fails validation is a corrupt or tampered manifest
// entry, not a policy skip: it fails the entry, so the restore is partial.
func TestRestoreJunctions_InvalidRecordedTargetIsAFailedEntry(t *testing.T) {
	calls := stubJunctionInstall(t, nil, nil)
	result := &RestoreResult{}
	restoreJunctions(`C:\`, []SnapshotJunction{{SourcePath: `C:\Users\a\x`, Target: `\\attacker\share`}}, false, nil, result)
	if len(*calls) != 0 || result.FilesFailed != 1 || len(result.FailedFiles) != 1 {
		t.Fatalf("result = %+v calls = %+v", result, *calls)
	}
}

// Nothing is created beneath a directory whose recorded security descriptor
// could not be applied: junctions are refused there like files and links.
func TestRestoreJunctions_BlockedDirectoryIsAFailedEntry(t *testing.T) {
	calls := stubJunctionInstall(t, nil, nil)
	result := &RestoreResult{}
	blockedRel, _ := restoreRelativePath(`C:\Users\a\My Music`)
	restoreJunctions(`C:\`, []SnapshotJunction{
		{SourcePath: `C:\Users\a\My Music`, Target: `C:\Users\a\Music`},
		{SourcePath: `C:\Users\b\My Music`, Target: `C:\Users\b\Music`},
	}, false, func(relative string) string {
		if relative == blockedRel {
			return "Users"
		}
		return ""
	}, result)
	if len(*calls) != 1 || !strings.Contains((*calls)[0].target, `Users\b`) {
		t.Fatalf("only the unblocked junction may be created, got %+v", *calls)
	}
	if result.FilesFailed != 1 || result.FailedFiles[0] != `C:\Users\a\My Music` || result.FilesRestored != 1 {
		t.Fatalf("result = %+v", result)
	}
}

func TestRestoreJunctions_InstallFailureIsAFailedEntry(t *testing.T) {
	stubJunctionInstall(t, errors.New("exists and is not a junction"), nil)
	result := &RestoreResult{}
	restoreJunctions(`C:\`, []SnapshotJunction{{SourcePath: `C:\Users\a\My Music`, Target: `C:\Users\a\Music`}}, false, nil, result)
	if result.FilesFailed != 1 || len(result.FailedFiles) != 1 || result.FailedFiles[0] != `C:\Users\a\My Music` {
		t.Fatalf("result = %+v", result)
	}
}

// A Windows snapshot restored on another OS: one summary warning, no failure,
// so the rest of the restore still completes. Decided before any target is
// computed: an alternate-location rewrite on a non-Windows root would
// otherwise refuse each junction separately.
func TestRestoreJunctions_UnsupportedHostWarnsOnce(t *testing.T) {
	calls := stubJunctionInstall(t, nil, nil)
	junctionsSupported = false
	result := &RestoreResult{}
	skipped := restoreJunctions(`/restore`, []SnapshotJunction{
		{SourcePath: `C:\a`, Target: `C:\b`},
		{SourcePath: `C:\c`, Target: `C:\d`},
	}, false, nil, result)
	if skipped != 2 || len(*calls) != 0 || result.FilesFailed != 0 || result.FilesRestored != 0 || len(result.Warnings) != 1 ||
		!strings.Contains(result.Warnings[0], "2 junction(s) not recreated") {
		t.Fatalf("skipped=%d result=%+v", skipped, result)
	}
}

// The installer's own unsupported error (a host the build thought could)
// is still summarised once, not failed.
func TestRestoreJunctions_InstallerUnsupportedWarnsOnce(t *testing.T) {
	stubJunctionInstall(t, securefs.ErrJunctionUnsupported, nil)
	result := &RestoreResult{}
	restoreJunctions(`C:\`, []SnapshotJunction{
		{SourcePath: `C:\a`, Target: `C:\b`},
		{SourcePath: `C:\c`, Target: `C:\d`},
	}, false, nil, result)
	if result.FilesFailed != 0 || result.FilesRestored != 0 || len(result.Warnings) != 1 ||
		!strings.Contains(result.Warnings[0], "2 junction(s) not recreated") {
		t.Fatalf("result = %+v", result)
	}
}

// addJunctionsToManifest rewrites a test snapshot's manifest with junctions.
func addJunctionsToManifest(t *testing.T, provider interface {
	Download(string, string) error
	Upload(string, string) error
}, snapshotID string, junctions []SnapshotJunction) {
	t.Helper()
	manifestKey := filepath.ToSlash(filepath.Join("snapshots", snapshotID, "manifest.json"))
	tmp := filepath.Join(t.TempDir(), "m.json")
	if err := provider.Download(manifestKey, tmp); err != nil {
		t.Fatal(err)
	}
	var snap Snapshot
	data, _ := os.ReadFile(tmp)
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatal(err)
	}
	snap.Junctions = junctions
	out, _ := json.Marshal(snap)
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := provider.Upload(tmp, manifestKey); err != nil {
		t.Fatal(err)
	}
}

// End to end through RestoreFromSnapshot: the junction pass runs, honours the
// selection, and counts toward the result.
func TestRestoreFromSnapshot_RecreatesSelectedJunctions(t *testing.T) {
	provider, snapshotID := setupRestoreTestSnapshot(t, map[string]string{"a.txt": "hello"})
	addJunctionsToManifest(t, provider, snapshotID, []SnapshotJunction{
		{SourcePath: "/original/My Music", Target: `C:\Users\a\Music`, ModTime: time.Now().UTC()},
		{SourcePath: "/unselected/link", Target: `C:\x`, ModTime: time.Now().UTC()},
	})
	calls := stubJunctionInstall(t, nil, nil)
	target := t.TempDir()
	res, err := RestoreFromSnapshot(provider, RestoreConfig{
		SnapshotID: snapshotID, TargetPath: target, SelectedPaths: []string{"/original"},
		JunctionTargetsAsCaptured: true,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "completed" || res.FilesRestored != 2 || res.FilesFailed != 0 {
		t.Fatalf("result = %+v", res)
	}
	if len(*calls) != 1 || (*calls)[0].base != target || (*calls)[0].target != `C:\Users\a\Music` ||
		(*calls)[0].relative != filepath.Join("original", "My Music") {
		t.Fatalf("install calls = %+v", *calls)
	}
}

// A selection that matches only a junction is not "no files matched".
func TestRestoreFromSnapshot_JunctionOnlySelection(t *testing.T) {
	provider, snapshotID := setupRestoreTestSnapshot(t, map[string]string{"a.txt": "hello"})
	addJunctionsToManifest(t, provider, snapshotID, []SnapshotJunction{
		{SourcePath: "/profile/My Music", Target: `C:\Users\a\Music`},
	})
	calls := stubJunctionInstall(t, nil, nil)
	res, err := RestoreFromSnapshot(provider, RestoreConfig{
		SnapshotID: snapshotID, TargetPath: t.TempDir(), SelectedPaths: []string{"/profile"},
		JunctionTargetsAsCaptured: true,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || res.Status != "completed" || res.FilesRestored != 1 {
		t.Fatalf("result = %+v calls = %+v", res, *calls)
	}
}

// A selection matching only junctions that are all deliberately skipped
// (here a cross-volume target on an alternate restore) is "completed" with a
// warning, not "failed" with nothing failed.
func TestRestoreFromSnapshot_JunctionOnlySelectionAllSkippedIsCompleted(t *testing.T) {
	provider, snapshotID := setupRestoreTestSnapshot(t, map[string]string{"a.txt": "hello"})
	addJunctionsToManifest(t, provider, snapshotID, []SnapshotJunction{
		{SourcePath: "/profile/Elsewhere", Target: `E:\Elsewhere`},
	})
	calls := stubJunctionInstall(t, nil, nil)
	res, err := RestoreFromSnapshot(provider, RestoreConfig{
		SnapshotID: snapshotID, TargetPath: t.TempDir(), SelectedPaths: []string{"/profile"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 0 || res.Status != "completed" || res.FilesFailed != 0 || len(res.Warnings) != 1 {
		t.Fatalf("result = %+v calls = %+v", res, *calls)
	}
}

// Without the stub: on a non-Windows host the junction is reported, the
// restore still completes, and nothing is written at the junction's path.
func TestRestoreFromSnapshot_JunctionsOnNonWindowsHost(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("covers the non-Windows fallback")
	}
	provider, snapshotID := setupRestoreTestSnapshot(t, map[string]string{"a.txt": "hello"})
	addJunctionsToManifest(t, provider, snapshotID, []SnapshotJunction{
		{SourcePath: "/original/My Music", Target: `C:\Users\a\Music`},
	})
	target := t.TempDir()
	res, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: target}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "completed" || res.FilesFailed != 0 || res.FilesRestored != 1 {
		t.Fatalf("result = %+v", res)
	}
	if !strings.Contains(strings.Join(res.Warnings, "\n"), "1 junction(s) not recreated") {
		t.Fatalf("warnings = %v", res.Warnings)
	}
	if _, err := os.Lstat(filepath.Join(target, "original", "My Music")); !os.IsNotExist(err) {
		t.Fatalf("nothing may be written at the junction's path: %v", err)
	}
}

// Backward compatibility, new agent / old snapshot: a manifest with no
// junctions field never reaches the junction installer.
func TestRestoreFromSnapshot_OldManifestNeverInstallsJunctions(t *testing.T) {
	provider, snapshotID := setupRestoreTestSnapshot(t, map[string]string{"a.txt": "hello"})
	calls := stubJunctionInstall(t, nil, nil)
	res, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: t.TempDir()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 0 || res.Status != "completed" || res.FilesRestored != 1 {
		t.Fatalf("result = %+v calls = %+v", res, *calls)
	}
}

// Backward compatibility, old reader / new snapshot: junctions live in their
// own top-level array, so the "files" an older agent, recovery medium or API
// reads hold only kinds every shipped reader knows ("", symlink, dir). An
// unknown kind in "files" would make an older restore try to download an
// object with an empty key and fail the entry (verified on main before this
// change: "remote path is required", status partial), and fail the API's
// result schema, which enumerates kinds.
func TestSnapshotJSON_JunctionsStayOutOfFiles(t *testing.T) {
	snap := Snapshot{
		ID:    "s",
		Files: []SnapshotFile{{SourcePath: `C:\a.txt`, BackupPath: "snapshots/s/files/a"}, {SourcePath: `C:\d`, Kind: KindDir}},
		Junctions: []SnapshotJunction{
			{SourcePath: `C:\Users\a\My Music`, Target: `C:\Users\a\Music`, WinAttrs: 0x6},
		},
	}
	data, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	var legacy struct {
		Files []map[string]any `json:"files"`
	}
	if err := json.Unmarshal(data, &legacy); err != nil {
		t.Fatal(err)
	}
	if len(legacy.Files) != 2 {
		t.Fatalf("files = %v", legacy.Files)
	}
	for _, f := range legacy.Files {
		if k, _ := f["kind"].(string); k != "" && k != KindSymlink && k != KindDir {
			t.Fatalf("files carries kind %q an older reader does not know", k)
		}
	}
	if !strings.Contains(string(data), `"junctions":[{"sourcePath":"C:\\Users\\a\\My Music","target":"C:\\Users\\a\\Music"`) {
		t.Fatalf("manifest JSON = %s", data)
	}
	empty, _ := json.Marshal(Snapshot{ID: "s", Files: []SnapshotFile{}})
	if strings.Contains(string(empty), "junctions") {
		t.Fatalf("a manifest with no junctions must be byte-identical to before: %s", empty)
	}
}

func TestCapturedJunction_TrimsTrailingSeparator(t *testing.T) {
	info := fakeFileInfo{}
	for in, want := range map[string]string{`C:\Users\a\Music\`: `C:\Users\a\Music`, `D:\`: `D:\`} {
		sp := skippedReparsePoint{path: `C:\x`, kind: reparseKindJunction, target: in}
		j, ok := capturedJunction(&sp, info)
		if !ok || j.Target != want {
			t.Fatalf("capturedJunction(%q) = %+v, %v; want target %q", in, j, ok, want)
		}
	}
}

type fakeFileInfo struct{ os.FileInfo }

func (fakeFileInfo) ModTime() time.Time { return time.Unix(1, 0) }
func (fakeFileInfo) Sys() any           { return nil }
