package backup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The restore-target cases shared with the server-side check (#12671):
//
//	TS -> packages/shared/src/utils/restoreTargetRoot.test.ts
//	Go -> this file
//
// Each case records how the server classifies a target for a device of each
// kind (expect) and how this guard's parser reads it on that kind of host
// (guard). The property that ties them together: a target this helper
// would treat as a volume root is never one the server lets through
// without allowOverwriteOriginals. If either side changes, update the
// fixture together with the code on both sides.
const restoreTargetVectorsPath = "../../../packages/shared/src/fixtures/restore-target-root-vectors.json"

type restoreTargetVector struct {
	Target string            `json:"target"`
	Expect map[string]string `json:"expect"`
	Guard  map[string]string `json:"guard"`
	Note   string            `json:"note"`
}

var restoreTargetVectorHosts = []struct {
	name  string
	style pathStyle
}{
	{"windows", styleWindows},
	{"posix", stylePOSIX},
	{"darwin", styleDarwin},
}

func loadRestoreTargetVectors(t *testing.T) []restoreTargetVector {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(restoreTargetVectorsPath))
	if err != nil {
		t.Fatalf("read restore-target vectors: %v (the fixture lives in the shared package)", err)
	}
	var fx struct {
		Cases []restoreTargetVector `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse restore-target vectors: %v", err)
	}
	if len(fx.Cases) < 100 {
		t.Fatalf("restore-target vectors: %d cases; the fixture was truncated or moved", len(fx.Cases))
	}
	return fx.Cases
}

// guardTargetReading is how the guard reads a restore target on a host of
// the given style: "root" (a volume root), "folder", or "unreadable" (the
// guard then refuses the restore).
func guardTargetReading(target string, host pathStyle) string {
	g := newOriginalsGuardFor(target, host)
	switch {
	case !g.targetOK:
		return "unreadable"
	case len(g.target.parts) == 0:
		return "root"
	default:
		return "folder"
	}
}

// The guard's parser reads every case as recorded, for every host style
// (the parser is pure, so all three run on any host), and never reads as a
// volume root a target the server classifies not-root for that host.
func TestRestoreTargetVectors_GuardReading(t *testing.T) {
	roots := 0
	for _, v := range loadRestoreTargetVectors(t) {
		for _, h := range restoreTargetVectorHosts {
			got := guardTargetReading(v.Target, h.style)
			if want := v.Guard[h.name]; got != want {
				t.Errorf("%s guard reading of %q = %s, fixture says %s (%s)", h.name, v.Target, got, want, v.Note)
			}
			if got == "root" {
				roots++
				if v.Expect[h.name] == "not-root" {
					t.Errorf("%s: the guard reads %q as a volume root but the server classifies it not-root (%s)", h.name, v.Target, v.Note)
				}
			}
		}
	}
	if roots == 0 {
		t.Fatal("no case reads as a volume root: the comparison above checked nothing")
	}
}

// With this host's real path functions: a target that placement treats as a
// volume root (absolute, and nothing left after its volume once
// filepath.Clean has run; on macOS also the data volume path, which names
// the same folders as /) is never classified not-root by the server, and
// the guard never reads it as an ordinary folder. On Windows this is the
// real filepath.VolumeName/Clean (the Windows CI job runs it); elsewhere
// the POSIX ones, for the posix and darwin columns.
func TestRestoreTargetVectors_Placement(t *testing.T) {
	hosts := restoreTargetVectorHosts[1:]
	if runtime.GOOS == "windows" {
		hosts = restoreTargetVectorHosts[:1]
	}
	roots := 0
	for _, v := range loadRestoreTargetVectors(t) {
		if !filepath.IsAbs(v.Target) {
			continue // placement refuses a target that is not absolute
		}
		cleaned := filepath.Clean(v.Target)
		rest := strings.FieldsFunc(cleaned[len(filepath.VolumeName(cleaned)):], func(r rune) bool { return r == '\\' || r == '/' })
		for _, h := range hosts {
			parts := rest
			if h.style == styleDarwin {
				parts = withoutDarwinDataVolume(foldParts(parts))
			}
			if len(parts) != 0 {
				continue
			}
			roots++
			if v.Expect[h.name] == "not-root" {
				t.Errorf("%s: placement treats %q (cleaned %q) as a volume root but the server classifies it not-root (%s)", h.name, v.Target, cleaned, v.Note)
			}
			if v.Guard[h.name] == "folder" {
				t.Errorf("%s: placement treats %q (cleaned %q) as a volume root but the guard reads a folder (%s)", h.name, v.Target, cleaned, v.Note)
			}
		}
	}
	if roots == 0 {
		t.Fatal("no case is a volume root for placement: the comparison above checked nothing")
	}
}

func foldParts(parts []string) []string {
	folded := make([]string, len(parts))
	for i, p := range parts {
		folded[i] = foldObjectKey(p)
	}
	return folded
}

// On macOS /System/Volumes/Data names the same folders as / (#12671): the
// guard keys a target, a destination and a recorded path beneath it as if
// that prefix were /, so a restore to it is refused for files from /, and a
// recorded path spelled either way meets the other. Linux reads the prefix
// as an ordinary folder.
func TestOriginalsGuard_DarwinDataVolumeIsTheRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX placement")
	}
	withPOSIXPaths(t)
	for _, target := range []string{"/System/Volumes/Data", "/System/Volumes/Data/", "/system/volumes/data", "/x/../System/Volumes/Data"} {
		recorded := []string{"/Users/a/doc.txt"}
		if f := guardOn(styleDarwin, target, recorded, recorded); f.count != 1 {
			t.Errorf("darwin, target %s: %+v; want refused as an overwrite", target, f)
		}
		if f := guardOn(stylePOSIX, target, recorded, recorded); f.count != 0 || f.uncheckedErr != nil {
			t.Errorf("linux, target %s: %+v; want allowed (an ordinary folder there)", target, f)
		}
	}
	// A nested copy recorded under the data volume spelling is found from a
	// target spelled through /, and the reverse.
	for _, tc := range []struct{ target, nested string }{
		{"/Users/a/restore", "/System/Volumes/Data/Users/a/restore/Users/a/doc.txt"},
		{"/System/Volumes/Data/Users/a/restore", "/Users/a/restore/Users/a/doc.txt"},
	} {
		recorded := []string{"/Users/a/doc.txt", tc.nested}
		if f := guardOn(styleDarwin, tc.target, recorded, recorded[:1]); f.count != 1 {
			t.Errorf("darwin, target %s, nested %s: %+v; want refused", tc.target, tc.nested, f)
		}
		if f := guardOn(stylePOSIX, tc.target, recorded, recorded[:1]); f.count != 0 || f.uncheckedErr != nil {
			t.Errorf("linux, target %s, nested %s: %+v; want allowed", tc.target, tc.nested, f)
		}
	}
	// The cost of the rule: a destination that enters the data volume
	// spelling from above it is no longer read as under the target, and the
	// check fails closed.
	recorded := []string{"/Data/doc.txt"}
	if f := guardOn(styleDarwin, "/System/Volumes", recorded, recorded); f.uncheckedErr == nil && f.count == 0 {
		t.Errorf("darwin, target /System/Volumes: %+v; want refused or a failed check", f)
	}
	// Ordinary folders are unaffected.
	for _, target := range []string{"/Users/a/restore", "/System/Volumes/Data/Users/a/restore", "/System/Volumes/DataX"} {
		recorded := []string{"/Users/a/doc.txt", "/srv/x"}
		if f := guardOn(styleDarwin, target, recorded, recorded); f.count != 0 || f.uncheckedErr != nil {
			t.Errorf("darwin, target %s: %+v; want allowed", target, f)
		}
	}
}
