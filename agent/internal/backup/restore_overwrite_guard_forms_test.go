package backup

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// windowsVolumeName2 is filepath.VolumeName as Windows computes it, ported
// from go1.26 internal/filepathlite volumeNameLen, so the guard can run over
// Windows paths on any host: FromSlash of the volume prefix, as
// filepathlite.VolumeName returns it. On Windows the tests use the real one,
// and TestOriginalsGuard_PlacementParity pins this port to it.
func windowsVolumeName2(p string) string {
	return strings.ReplaceAll(p[:windowsVolumeNameLen(p)], "/", `\`)
}

// windowsVolumeNameLen is go1.26 internal/filepathlite volumeNameLen.
func windowsVolumeNameLen(p string) int {
	isSep := func(b byte) bool { return b == '\\' || b == '/' }
	hasPrefixFold := func(prefix string) bool {
		if len(p) < len(prefix) {
			return false
		}
		for i := 0; i < len(prefix); i++ {
			if isSep(prefix[i]) {
				if !isSep(p[i]) {
					return false
				}
			} else if !strings.EqualFold(p[i:i+1], prefix[i:i+1]) {
				return false
			}
		}
		return len(p) == len(prefix) || isSep(p[len(prefix)])
	}
	uncLen := func(start int) int {
		count := 0
		for i := start; i < len(p); i++ {
			if isSep(p[i]) {
				if count++; count == 2 {
					return i
				}
			}
		}
		return len(p)
	}
	switch {
	case len(p) >= 2 && p[1] == ':':
		return 2
	case len(p) == 0 || !isSep(p[0]):
		return 0
	case hasPrefixFold(`\\.\UNC`):
		return uncLen(len(`\\.\UNC\`))
	case hasPrefixFold(`\\.`), hasPrefixFold(`\\?`), hasPrefixFold(`\??`):
		if len(p) == 3 {
			return 3
		}
		if i := strings.IndexAny(p[4:], `\/`); i >= 0 {
			return 4 + i
		}
		return len(p)
	case len(p) >= 2 && isSep(p[1]):
		return uncLen(2)
	}
	return 0
}

// withWindowsPaths makes placement read Windows paths: the real
// filepath.VolumeName on Windows, windowsVolumeName2 elsewhere.
func withWindowsPaths(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		return
	}
	orig := volumeName
	volumeName = windowsVolumeName2
	t.Cleanup(func() { volumeName = orig })
}

// withPOSIXPaths makes placement read POSIX paths (filepath.VolumeName is
// "" for every path off Windows). Callers skip on Windows, where
// restoreRelativePath's CleanRelative is the Windows one.
func withPOSIXPaths(t *testing.T) {
	t.Helper()
	orig := volumeName
	volumeName = func(string) string { return "" }
	t.Cleanup(func() { volumeName = orig })
}

// guardOn runs the guard as a host of the given style would, over a
// snapshot that holds recorded (every entry noted) and selects selected.
func guardOn(host pathStyle, target string, recorded, selected []string) overwriteFinding {
	g := newOriginalsGuardFor(target, host)
	for _, p := range recorded {
		g.noteOriginal(p)
	}
	return g.check(selected, originalsOf(recorded))
}

const formsGUID = `Volume{01234567-89ab-cdef-0123-456789abcdef}`

// Every spelling placement strips like a drive letter lands on the original
// when the target is that volume's root: each must be refused. Before the
// guard read paths with the host parser, all but the first row passed
// silently. `\Users\a\x` and `/Users/a/x` carry no volume: placement writes
// them under the target, and the guard reads them on the target's volume
// root, so a restore to a volume root is refused (the server already asks
// for confirmation there).
func TestOriginalsGuard_RecordedFormsAtVolumeRoot(t *testing.T) {
	withWindowsPaths(t)
	for _, tc := range []struct{ target, recorded string }{
		{`C:\`, `C:\Users\a\x`}, // the control
		{`C:\`, `c:/Users/a/x`},
		{`C:\`, `\\?\C:\Users\a\x`},
		{`C:\`, `\??\C:\Users\a\x`},
		{`C:\`, `\\.\C:\Users\a\x`},
		{`\\?\` + formsGUID + `\`, `\??\` + formsGUID + `\Users\a\x`},
		{`\\?\` + formsGUID + `\`, `\\?\` + formsGUID + `\Users\a\x`},
		{`C:\`, `//?/C:/Users/a/x`},
		{`C:\`, `\\?/C:\Users\a\x`},
		{`C:\`, `/??/C:/Users/a/x`},
		{`\\srv.invalid\share\`, `\\srv.invalid\share\a\x`},
		{`\\srv.invalid\share\`, `//srv.invalid/share/a/x`},
		{`\\.\UNC\srv.invalid\share\`, `\\.\UNC\srv.invalid\share\a\x`},
		{`C:\`, `\Users\a\x`},
		{`C:\`, `/Users/a/x`},
		{`C:\`, `Users\a\x`},
		{`C:\`, `C:Users\a\x`},
	} {
		f := guardOn(styleWindows, tc.target, []string{tc.recorded}, []string{tc.recorded})
		if f.count != 1 {
			t.Errorf("target %s, entry %s: count %d (err %v); want refused as an overwrite", tc.target, tc.recorded, f.count, f.uncheckedErr)
		}
	}
}

// On POSIX placement trims every leading separator, `\` included, so a
// recorded `\etc/x` is written to <target>/etc/x: at the root target that
// is where the guard must read it too.
func TestOriginalsGuard_LeadingSeparatorsReadAsPlacementDoes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX placement")
	}
	withPOSIXPaths(t)
	for _, recorded := range []string{`\etc/cron.d/x`, `\/home/a/x`, `\\x`} {
		if f := guardOn(stylePOSIX, "/", []string{recorded}, []string{recorded}); f.count != 1 {
			t.Errorf("entry %q at /: %+v; want refused", recorded, f)
		}
	}
}

// Go's Windows VolumeName gives `\\?\UNC\srv\share\x` the volume `\\?\UNC`
// (only `\\.\UNC\` keeps server and share in it), so placement writes it to
// <target>\srv\share\x. The guard computes the destination with placement's
// own expression, so it sees that this one lands on another original.
func TestOriginalsGuard_DestinationFollowsPlacement(t *testing.T) {
	withWindowsPaths(t)
	for _, entry := range []string{`\\?\UNC\srv.invalid\share\x`, `\??\UNC\srv.invalid\share\x`} {
		recorded := []string{entry, `C:\srv.invalid\share\x`}
		if f := guardOn(styleWindows, `C:\`, recorded, recorded[:1]); f.count != 1 || f.overwrite != recorded[1] {
			t.Errorf("entry %s: finding %+v; want it to overwrite %s", entry, f, recorded[1])
		}
	}
}

// A recorded path whose volume the parser cannot read fails the check
// closed, selected or not, and the refusal names it.
func TestOriginalsGuard_UnreadablePathFailsClosed(t *testing.T) {
	withWindowsPaths(t)
	for _, bad := range []string{`\\srv.invalid`, `\\?\c:x\y`, `\\?\UNC\srv.invalid`, `\\?\`} {
		f := guardOn(styleWindows, `D:\Restore`, []string{`C:\docs\x`, bad}, []string{`C:\docs\x`})
		var unchecked *uncheckedPathError
		if f.count != 0 || !errors.As(f.uncheckedErr, &unchecked) || unchecked.path != bad {
			t.Errorf("original %q: finding %+v; want a failed check naming it", bad, f)
			continue
		}
		msg := overwriteCheckFailedRefusal(`D:\Restore`, f.uncheckedErr)
		if !strings.Contains(msg, bad) || !strings.Contains(msg, "default staging location") {
			t.Errorf("refusal %q; want the path and the staging advice", msg)
		}
	}
	// A target the parser cannot read fails closed too.
	if f := guardOn(styleWindows, `D:foo`, []string{`D:\x`}, []string{`D:\x`}); f.uncheckedErr == nil {
		t.Errorf("unreadable target: %+v; want a failed check", f)
	}
}

// The ordinary shapes stay allowed: alternate folders on the same and
// other volumes, a share, legacy VSS entries without an OriginalPath,
// subsets, and the cross-OS restores the restore API offers (a snapshot
// from one OS restored on a device running the other).
const legacyVSSEntry = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\Users\a\x`

func TestOriginalsGuard_OrdinaryRestoresAllowedOnWindows(t *testing.T) {
	const vss = legacyVSSEntry
	{
		withWindowsPaths(t)
		snapshot := []string{`C:\Users\a\x`, `C:\Users\a\y`, `D:\data\z`, `\\srv.invalid\share\docs\w`, vss}
		for _, target := range []string{`D:\Restore`, `C:\Restore`, `C:\Users\b`, `E:\`, `\\nas.invalid\restore\here`, `\\?\` + formsGUID + `\restore`, `C:\Restore\new\folder`} {
			for _, selected := range [][]string{snapshot, snapshot[:1], {vss}} {
				if f := guardOn(styleWindows, target, snapshot, selected); f.count != 0 || f.uncheckedErr != nil {
					t.Errorf("target %s, selected %v: %+v; want allowed", target, selected, f)
				}
			}
		}
		// A POSIX snapshot restored on Windows.
		posix := []string{`/home/a/x`, `/etc/hosts`, `/var/log/app:2026.log`}
		for _, target := range []string{`D:\Restore`, `C:\Restore`} {
			if f := guardOn(styleWindows, target, posix, posix); f.count != 0 || f.uncheckedErr != nil {
				t.Errorf("POSIX snapshot to %s: %+v; want allowed", target, f)
			}
		}
	}
}

// The POSIX half of the ordinary shapes (POSIX placement: not on Windows).
func TestOriginalsGuard_OrdinaryRestoresAllowedOnPOSIX(t *testing.T) {
	const vss = legacyVSSEntry
	if runtime.GOOS == "windows" {
		t.Skip("POSIX placement")
	}
	{
		withPOSIXPaths(t)
		snapshot := []string{`/home/a/x`, `/home/a/y`, `/srv/data/z`, `relative/entry`}
		for _, target := range []string{`/restore`, `/home/b`, `/srv/restore/new`} {
			for _, selected := range [][]string{snapshot, snapshot[:1]} {
				if f := guardOn(stylePOSIX, target, snapshot, selected); f.count != 0 || f.uncheckedErr != nil {
					t.Errorf("target %s, selected %v: %+v; want allowed", target, selected, f)
				}
			}
		}
		// A Windows snapshot restored on Linux or macOS, VSS entries too.
		windows := []string{`C:\Users\a\x`, `\\srv.invalid\share\w`, vss, `\??\C:\y`}
		if f := guardOn(stylePOSIX, `/restore`, windows, windows); f.count != 0 || f.uncheckedErr != nil {
			t.Errorf("Windows snapshot to /restore: %+v; want allowed", f)
		}
		// … and refused at the root, where placement's join is the identity.
		if f := guardOn(stylePOSIX, `/`, windows[:1], windows[:1]); f.count != 1 {
			t.Errorf("Windows snapshot to /: %+v; want refused", f)
		}
	}
}

// An entry placement refuses (restoreRelativePath fails) is never written,
// so it cannot overwrite anything: it is exempt as a destination.
func TestOriginalsGuard_EntryPlacementSkipsIsExempt(t *testing.T) {
	withWindowsPaths(t)
	recorded := []string{`C:\`, `D:\docs\x`}
	if f := guardOn(styleWindows, `C:\`, recorded, recorded); f.count != 0 || f.uncheckedErr != nil {
		t.Fatalf("volume-root entry (placement skips it): %+v; want allowed", f)
	}
	if _, placed, _ := newOriginalsGuardFor(`C:\`, styleWindows).destinationKey(`C:\`); placed {
		t.Fatal("placement places the volume root itself; the exemption's premise is wrong")
	}
}

// Placement splits every form as listed: the host's volumeName and
// restoreRelativePath (on Windows the real filepath, elsewhere
// windowsVolumeName2, which this pins to it). Go's Windows VolumeName
// returns the volume with its slashes turned to backslashes
// (FromSlash(p[:volumeNameLen(p)])), the same length as spelled: placement
// uses only that length (stripVolumeAndLeadingSeparators) and the
// separators of the rest are cleaned by filepath.Join, so the split point,
// the volume as Go returns it and the remainder are what is compared.
func TestOriginalsGuard_PlacementParity(t *testing.T) {
	withWindowsPaths(t)
	for _, tc := range []struct{ path, volume, rel string }{
		{`C:\Users\a\x`, `C:`, `Users\a\x`},
		{`c:/Users/a/x`, `c:`, `Users\a\x`},
		{`\\?\C:\Users\a\x`, `\\?\C:`, `Users\a\x`},
		{`\??\C:\Users\a\x`, `\??\C:`, `Users\a\x`},
		{`\\.\C:\Users\a\x`, `\\.\C:`, `Users\a\x`},
		{`//?/C:/Users/a/x`, `\\?\C:`, `Users\a\x`},
		{`/??/C:/Users/a/x`, `\??\C:`, `Users\a\x`},
		{`\\?\` + formsGUID + `\Users\x`, `\\?\` + formsGUID, `Users\x`},
		{`\\srv\share\a\x`, `\\srv\share`, `a\x`},
		{`//srv/share/a/x`, `\\srv\share`, `a\x`},
		{`\\.\UNC\srv\share\a\x`, `\\.\UNC\srv\share`, `a\x`},
		{`\\?\UNC\srv\share\a\x`, `\\?\UNC`, `srv\share\a\x`},
		{`\??\UNC\srv\share\a\x`, `\??\UNC`, `srv\share\a\x`},
		{`\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\x`, `\\?\GLOBALROOT`, `Device\HarddiskVolumeShadowCopy1\x`},
		{`\Users\a\x`, ``, `Users\a\x`},
		{`/Users/a/x`, ``, `Users\a\x`},
		{`C:Users\x`, `C:`, `Users\x`},
	} {
		got := volumeName(tc.path)
		if got != tc.volume {
			t.Errorf("volumeName(%q) = %q, want %q", tc.path, got, tc.volume)
		}
		if len(got) != len(tc.volume) || strings.ReplaceAll(tc.path[:min(len(got), len(tc.path))], "/", `\`) != tc.volume {
			t.Errorf("volumeName(%q) splits at %d (%q), want after %q", tc.path, len(got), tc.path[:min(len(got), len(tc.path))], tc.volume)
		}
		rel, err := restoreRelativePath(tc.path)
		if err != nil || strings.ReplaceAll(rel, "/", `\`) != tc.rel {
			t.Errorf("restoreRelativePath(%q) = %q, %v; want %q", tc.path, rel, err, tc.rel)
			continue
		}
	}
}

// A re-run into the same folder (a restore already there) is still
// allowed: the guard reads no file system state. Resume of an interrupted
// restore into its target: TestRestoreContent_CancelDrainsDownloadsAndResumes.
func TestRestoreFromSnapshot_RerunIntoSameFolderRestores(t *testing.T) {
	provider, snapshotID, original := setupOriginalTestSnapshot(t)
	target := t.TempDir()
	for run := 1; run <= 2; run++ {
		result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: target, WorkRoot: t.TempDir()}, nil)
		if err != nil || result.Status != "completed" {
			t.Fatalf("run %d: %+v, %v; want completed", run, result, err)
		}
	}
	if got, _ := os.ReadFile(original); string(got) != "live" {
		t.Fatalf("original now holds %q", got)
	}
}

// A computed destination must fall under the chosen target. Go's Windows
// volume rule and the guard's parser read a bare `\\.\UNC` (any spelling)
// differently once a relative path is joined to it, so the destination of
// C:\fs\data\docs\r.docx lands on the share \\fs\data, which the snapshot
// also holds: refused, or a failed check, never allowed.
func TestOriginalsGuard_DestinationsStayUnderTarget(t *testing.T) {
	withWindowsPaths(t)
	recorded := []string{`C:\fs\data\docs\r.docx`, `\\fs\data\docs\r.docx`}
	for _, target := range []string{`\\.\UNC`, `\\?\UNC`, `\??\UNC`, `\\.\unc`, `//./UNC`, `//?/UNC`, `\\.\UNC\`, `\\?\unc\`} {
		f := guardOn(styleWindows, target, recorded, recorded[:1])
		if f.count == 0 && f.uncheckedErr == nil {
			t.Errorf("target %s: %+v; want refused or a failed check", target, f)
		}
	}
	// A bare UNC device prefix is unreadable as a target on its own,
	// before any destination is joined to it.
	for _, target := range []string{`\\.\UNC`, `\\?\UNC`, `\??\UNC`, `//?/unc`} {
		if newOriginalsGuardFor(target, styleWindows).targetOK {
			t.Errorf("target %s read as a folder; want unreadable", target)
		}
	}
	// The control: a folder on a share, with a normal snapshot.
	normal := []string{`C:\Users\a\x`, `\\fs\data\docs\r.docx`}
	if f := guardOn(styleWindows, `\\srv\share\restore`, normal, normal); f.count != 0 || f.uncheckedErr != nil {
		t.Errorf("share folder target: %+v; want allowed", f)
	}
}

// goVolumeKey is the guard's volume form of the volume Go's filepath (the
// host's volumeName) gives s. Go keeps a `\\?\UNC\` path's server and share
// out of the volume; the location is the share all the same, so those two
// components are taken from the remainder.
func goVolumeKey(s string) string {
	v := volumeName(s)
	k := strings.ToLower(strings.ReplaceAll(v, "/", `\`))
	for _, prefix := range []string{`\\?\`, `\??\`, `\\.\`} {
		if rest, ok := strings.CutPrefix(k, prefix); ok {
			k = rest
			break
		}
	}
	if rest, ok := strings.CutPrefix(k, `\\`); ok {
		k = `unc\` + rest
	}
	if k == "unc" {
		parts := strings.FieldsFunc(strings.ToLower(s[len(v):]), func(r rune) bool { return r == '\\' || r == '/' })
		if len(parts) >= 2 {
			k = `unc\` + parts[0] + `\` + parts[1]
		}
	}
	return k
}

// For every target spelling the guard accepts, its volume split of the
// target and of each destination equals the real filepath.VolumeName's (on
// Windows CI), and every placed destination lies under the target (the
// entries may still collide: a volume-root target is refused for its own
// files). A spelling where they would differ must be one the guard fails.
func TestOriginalsGuard_TargetSpellingParity(t *testing.T) {
	withWindowsPaths(t)
	const guid = `Volume{01234567-89ab-cdef-0123-456789abcdef}`
	refused := map[string]bool{`\\.\UNC`: true, `\\?\UNC`: true, `\??\UNC`: true, `D:`: true, `D:restore`: true, `\\srv`: true}
	entries := []string{`C:\Users\a\x`, `\\srv\share\docs\y`, `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\z`, `/home/a/w`}
	for _, target := range []string{
		`D:\`, `d:/`, `D:\Restore`, `D:/Restore/new`, `\\?\D:\Restore`, `\??\D:\Restore`, `\\.\D:\Restore`, `//?/D:/Restore`,
		`\\?\` + guid + `\`, `\\?\` + guid + `\Restore`,
		`\\srv\share`, `\\srv\share\Restore`, `//srv/share/Restore`, `\\.\UNC\srv\share\Restore`, `\\?\UNC\srv\share\Restore`, `\??\UNC\srv\share\Restore`,
		`\\.\UNC`, `\\?\UNC`, `\??\UNC`, `D:`, `D:restore`, `\\srv`,
	} {
		if strings.HasPrefix(target, "//") && runtime.GOOS != "windows" {
			continue // POSIX filepath.Join folds the leading "//": only the real Windows Join keeps it
		}
		g := newOriginalsGuardFor(target, styleWindows)
		for _, p := range entries {
			g.noteOriginal(p)
		}
		f := g.check(entries, originalsOf(entries))
		if refused[target] {
			if f.uncheckedErr == nil {
				t.Errorf("target %s: %+v; want a failed check", target, f)
			}
			continue
		}
		if !g.targetOK || f.uncheckedErr != nil {
			t.Errorf("target %s: %+v; want the check to finish", target, f)
			continue
		}
		if got := goVolumeKey(target); got != g.target.volume {
			t.Errorf("target %s: guard volume %q, filepath's %q", target, g.target.volume, got)
		}
		for _, p := range entries {
			rel, err := restoreRelativePath(p)
			if err != nil {
				continue
			}
			joined := filepath.Join(target, rel)
			dest, placed, err := g.destinationKey(p)
			if !placed || err != nil {
				t.Errorf("target %s, entry %s: not placed (%v)", target, p, err)
				continue
			}
			if got := goVolumeKey(joined); got != dest.volume {
				t.Errorf("target %s, destination %s: guard volume %q, filepath's %q", target, joined, dest.volume, got)
			}
			if !g.target.contains(dest) {
				t.Errorf("target %s: destination %s is not under it", target, joined)
			}
		}
	}
}

// On macOS the default volume ignores case and Unicode normalisation, so the
// guard folds both there: a nested copy spelled in another case, or in
// another normalisation, is refused. Linux compares as written.
func TestOriginalsGuard_DarwinFoldsCaseAndNormalisation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX placement")
	}
	if runtime.GOOS == "darwin" && hostPathStyle() != styleDarwin {
		t.Fatal("a macOS host does not fold names")
	}
	withPOSIXPaths(t)
	for name, tc := range map[string]struct{ target, nested, selected string }{
		"case":          {"/Users/a/restore", "/Users/a/Restore/Users/a/doc.txt", "/Users/a/doc.txt"},
		"normalisation": {"/Users/a/caf\u00e9", "/Users/a/cafe\u0301/Users/a/doc.txt", "/Users/a/doc.txt"},
	} {
		recorded := []string{tc.selected, tc.nested}
		if f := guardOn(styleDarwin, tc.target, recorded, recorded[:1]); f.count != 1 {
			t.Errorf("darwin, %s: %+v; want refused", name, f)
		}
		if f := guardOn(stylePOSIX, tc.target, recorded, recorded[:1]); f.count != 0 || f.uncheckedErr != nil {
			t.Errorf("linux, %s: %+v; want allowed (case-sensitive volume)", name, f)
		}
	}
}

// The invariant itself, whatever the spelling that triggers it: when the
// guard's reading of the target and of a destination disagree (simulated
// here), the check fails rather than comparing keys that cannot meet. On
// Windows a `..` through a `\\?\UNC\` target is one such real case: Go's
// Clean climbs over the share, the parser does not.
func TestOriginalsGuard_DestinationOutsideTargetFailsClosed(t *testing.T) {
	withWindowsPaths(t)
	g := newOriginalsGuardFor(`D:\Restore`, styleWindows)
	g.target = pathKey{volume: "d:", parts: []string{"ELSEWHERE"}}
	f := g.check([]string{`C:\Users\a\x`}, originalsOf([]string{`C:\Users\a\x`}))
	if !errors.Is(f.uncheckedErr, errDestinationOutsideTarget) {
		t.Fatalf("finding %+v; want a failed check for a destination outside the target", f)
	}
	if runtime.GOOS == "windows" {
		recorded := []string{`C:\other\docs\x`, `\\srv\other\docs\x`}
		if f := guardOn(styleWindows, `\\?\UNC\srv\share\..\other`, recorded, recorded[:1]); f.count == 0 && f.uncheckedErr == nil {
			t.Errorf("target through `..` over a share: %+v; want refused or a failed check", f)
		}
	}
}
