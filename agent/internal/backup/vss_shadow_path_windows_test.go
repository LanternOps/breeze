//go:build windows

package backup

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/vss"
	"golang.org/x/sys/windows"
)

// rewritePathsForVSS is the seam that decides whether a backup actually reads
// through the shadow copy or silently reads the live volume, and until now it
// had no test at all. It could not be covered portably alongside
// originalPathsForVSS in backup_test.go: it calls filepath.VolumeName, whose
// non-Windows implementation always returns "", so on macOS/Linux every lookup
// misses and only the fallback branch runs. Hence a Windows-gated file.
//
// What this does and does not close, precisely — the provider side is already
// guarded. vss/vss_windows_live_test.go asserts that ShadowPaths is keyed on
// the caller's volume string rather than the normalised mount point, so a
// re-key there fails that test. The gaps are narrower than "nobody would
// notice":
//
//   - Nothing called rewritePathsForVSS. Both live suites reconstruct the
//     shadow path by hand (`shadow + target[len(vol):]`), so a change on
//     backup.go's side of the seam — the prefix arithmetic, or the lookup key
//     — is not caught by them.
//   - Neither live suite runs in CI. Both are opt-in behind BREEZE_VSS_LIVE
//     and need elevation and a real snapshot, so the provider-side guard is a
//     guard only for whoever remembers to run it.
//
// The tests below therefore pin backup.go's half of the contract in CI, and
// TestRewritePathsForVSS_MountPointKeyedShadowMapIsReportedUnmapped encodes the
// #2999 hazard itself as an executable statement rather than a comment.

func TestRewritePathsForVSS_RoutesPathsThroughShadowRoot(t *testing.T) {
	const shadowRoot = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`
	shadowPaths := map[string]string{"C:": shadowRoot}

	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "nested path keeps its remainder",
			in:   `C:\Users\data\f.txt`,
			want: shadowRoot + `\Users\data\f.txt`,
		},
		{
			name: "volume root with separator",
			in:   `C:\`,
			want: shadowRoot + `\`,
		},
		{
			name: "bare volume name",
			in:   `C:`,
			want: shadowRoot,
		},
		{
			name: "unshadowed volume falls back to the live path",
			in:   `D:\other\f.txt`,
			want: `D:\other\f.txt`,
		},
		{
			// VSS cannot snapshot a UNC share, so this always falls back.
			// liveReadPaths filters it out of the operator warning; the
			// rewrite itself must still leave the path usable.
			name: "UNC path falls back unchanged",
			in:   `\\server\share\dir\f.txt`,
			want: `\\server\share\dir\f.txt`,
		},
		{
			// filepath.VolumeName is "" here, which extractVolumes never
			// requests, so no shadow root can exist for it.
			name: "drive-rooted path with no volume falls back unchanged",
			in:   `\Data\f.txt`,
			want: `\Data\f.txt`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, _ := rewritePathsForVSS([]string{tt.in}, shadowPaths, noStagingIdx)
			if got[0] != tt.want {
				t.Errorf("rewritePathsForVSS(%q) = %q, want %q", tt.in, got[0], tt.want)
			}
		})
	}
}

// TestRewritePathsForVSS_KeyFormatMatchesExtractVolumes pins backup.go's half
// of the keying contract: whatever extractVolumes hands the provider must be a
// key this lookup hits.
//
// Scope, so nobody trusts this further than it goes: both functions derive
// their key from filepath.VolumeName on the same strings, so this fails only
// if one of them stops doing that. It does NOT guard the provider's side of
// the contract — vss.CreateShadowCopy storing the map under a different key is
// caught by vss_windows_live_test.go, which is opt-in and does not run in CI.
// The literal-format assertion below is the part that would survive a re-key
// on either side.
func TestRewritePathsForVSS_KeyFormatMatchesExtractVolumes(t *testing.T) {
	paths := []string{`C:\Users\data`, `C:\Logs\app.log`, `D:\Backups`}

	volumes := extractVolumes(paths)
	// Pin the literal format rather than only the round trip: "C:", never
	// "C:\". This is the string the provider is required to key on.
	want := []string{"C:", "D:"}
	if len(volumes) != len(want) {
		t.Fatalf("extractVolumes = %v, want %v", volumes, want)
	}
	for i, vol := range volumes {
		if vol != want[i] {
			t.Fatalf("extractVolumes = %v, want %v (bare volume name, no trailing separator)", volumes, want)
		}
	}

	shadowPaths := make(map[string]string)
	for i, vol := range volumes {
		shadowPaths[vol] = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy` + strconv.Itoa(i+1)
	}

	rewritten, unmapped := rewritePathsForVSS(paths, shadowPaths, noStagingIdx)
	if len(unmapped) != 0 {
		t.Fatalf("every path should route through a shadow copy, but %d fell back to the live volume: %v",
			len(unmapped), unmapped)
	}
	for i, p := range rewritten {
		if p == paths[i] {
			t.Errorf("path %q was not rewritten — extractVolumes and the shadow-path lookup disagree on key format", paths[i])
		}
	}
}

// TestRewritePathsForVSS_MountPointKeyedShadowMapIsReportedUnmapped turns the
// #2999 hazard from a comment into an executable statement. PR #3005 records
// that the session map "stays keyed on the caller's original string — re-keying
// it would make rewritePathsForVSS's lookup miss and silently read the live
// volume." This is what that miss looks like: mount-point keys ("C:\") produce
// no match, and the path must be REPORTED rather than quietly served live.
func TestRewritePathsForVSS_MountPointKeyedShadowMapIsReportedUnmapped(t *testing.T) {
	shadowPaths := map[string]string{`C:\`: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`}

	rewritten, unmapped := rewritePathsForVSS([]string{`C:\Users\data`}, shadowPaths, noStagingIdx)

	if len(unmapped) != 1 || unmapped[0] != 0 {
		t.Fatalf("a mount-point-keyed shadow map must leave the path unmapped and reported, got unmapped=%v", unmapped)
	}
	if rewritten[0] != `C:\Users\data` {
		t.Errorf("unmapped path should be left as the original live path, got %q", rewritten[0])
	}
}

// rewritePathsForVSS and originalPathsForVSS are inverses, and the journal's
// resume key depends on that. backup_test.go covers the inverse portably with
// fake "VOL:" paths; only here can the real pair be round-tripped against
// Windows volume semantics, including the bare "C:" and "C:\" forms where an
// off-by-one in the prefix arithmetic would hide.
func TestRewritePathsForVSS_RoundTripsThroughOriginalPathsForVSS(t *testing.T) {
	const shadowRoot = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`
	shadowPaths := map[string]string{"C:": shadowRoot}
	originals := []string{`C:\Users\data\f.txt`, `C:\`, `C:`}

	rewritten, unmapped := rewritePathsForVSS(originals, shadowPaths, noStagingIdx)
	if len(unmapped) != 0 {
		t.Fatalf("unmapped = %v, want none", unmapped)
	}

	files := make([]backupFile, len(rewritten))
	for i, p := range rewritten {
		files[i] = backupFile{sourcePath: p}
	}
	originalPathsForVSS(files, shadowPaths)

	for i, f := range files {
		if f.originalPath != originals[i] {
			t.Errorf("round trip of %q produced %q", originals[i], f.originalPath)
		}
	}
}

// A path that falls back is a path read from the LIVE volume: in-use files
// there fail or come out torn, which is exactly the class of failure #2999
// reported. The fallback is legitimate (a volume whose snapshot failed still
// gets a best-effort live read), but it must not be invisible.
func TestRewritePathsForVSS_ReportsUnmappedPathsRatherThanFailingSilently(t *testing.T) {
	shadowPaths := map[string]string{"C:": `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`}
	paths := []string{`C:\shadowed`, `D:\live`, `E:\also-live`}

	rewritten, unmapped := rewritePathsForVSS(paths, shadowPaths, noStagingIdx)

	if len(unmapped) != 2 {
		t.Fatalf("unmapped = %v, want the two unshadowed volumes reported", unmapped)
	}
	// Indices, not paths, so the caller can tell an unshadowed user volume
	// apart from the system-state staging dir it wrote itself.
	for _, idx := range unmapped {
		if idx < 0 || idx >= len(paths) {
			t.Fatalf("unmapped index %d out of range", idx)
		}
		if rewritten[idx] != paths[idx] {
			t.Errorf("unmapped path %d should be left as the original live path", idx)
		}
	}
	if unmapped[0] != 1 || unmapped[1] != 2 {
		t.Errorf("unmapped = %v, want [1 2]", unmapped)
	}
}

// TestRewritePathsForVSS_LeavesSystemStateStagingDirUnrewritten pins #3026.
//
// The staging dir is created by collectSystemState AFTER CreateShadowCopy has
// already taken the point-in-time image, so it cannot exist inside the
// snapshot. %TEMP% normally sits on C:, normally a shadowed backup volume, so
// before the fix the rewrite happily mapped the staging dir onto
// \\?\GLOBALROOT\...\Windows\Temp\breeze-systemstate-XXXX — a path that is not
// in the snapshot. The walk then found nothing, the stat failure was folded
// into the aggregate "backup file scan completed with errors" warning, and a
// run that also had configured file paths still reported success with
// SystemStateManifest set. (A system-state-only run fails on the len(files)==0
// guard instead.) Reachable whenever VSS and system-state collection are both
// enabled for the same run; server-dispatched system_image runs default VSS
// off, so it is opt-in rather than universal.
//
// The index is therefore excluded from the rewrite itself, not merely from the
// operator warning: the path must keep pointing at the live volume, which is
// the only place those artifacts exist.
func TestRewritePathsForVSS_LeavesSystemStateStagingDirUnrewritten(t *testing.T) {
	const shadowRoot = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`
	const staging = `C:\Windows\Temp\breeze-systemstate-1234`

	tests := []struct {
		name        string
		paths       []string
		shadowPaths map[string]string
		stagingIdx  int
		want        []string
		wantUnmap   []int
	}{
		{
			// The bug: staging on the SAME volume the snapshot covers.
			name:        "staging dir on a shadowed volume stays live while user paths are rewritten",
			paths:       []string{`C:\Users\data`, staging},
			shadowPaths: map[string]string{"C:": shadowRoot},
			stagingIdx:  1,
			want:        []string{shadowRoot + `\Users\data`, staging},
			wantUnmap:   []int{1},
		},
		{
			// Already correct before the fix, and must stay that way.
			name:        "staging dir on an unshadowed volume stays live",
			paths:       []string{`C:\Users\data`, `D:\Temp\breeze-systemstate-1234`},
			shadowPaths: map[string]string{"C:": shadowRoot},
			stagingIdx:  1,
			want:        []string{shadowRoot + `\Users\data`, `D:\Temp\breeze-systemstate-1234`},
			wantUnmap:   []int{1},
		},
		{
			// A system-state-only run (SystemStateEnabled, no configured
			// paths) puts the staging dir at index 0, so 0 must be a real
			// index here and never a second sentinel.
			name:        "staging dir at index 0 is excluded like any other",
			paths:       []string{staging},
			shadowPaths: map[string]string{"C:": shadowRoot},
			stagingIdx:  0,
			want:        []string{staging},
			wantUnmap:   []int{0},
		},
		{
			name:        "no staging dir this run leaves every path eligible for rewrite",
			paths:       []string{`C:\Users\data`, `C:\Logs`},
			shadowPaths: map[string]string{"C:": shadowRoot},
			stagingIdx:  noStagingIdx,
			want:        []string{shadowRoot + `\Users\data`, shadowRoot + `\Logs`},
			wantUnmap:   nil,
		},
		{
			// Defensive: a stale index must not silently skip a real user path.
			name:        "an out-of-range staging index excludes nothing",
			paths:       []string{`C:\Users\data`},
			shadowPaths: map[string]string{"C:": shadowRoot},
			stagingIdx:  7,
			want:        []string{shadowRoot + `\Users\data`},
			wantUnmap:   nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, unmapped := rewritePathsForVSS(tt.paths, tt.shadowPaths, tt.stagingIdx)
			if len(got) != len(tt.want) {
				t.Fatalf("rewritePathsForVSS returned %d paths, want %d", len(got), len(tt.want))
			}
			for i := range tt.want {
				if got[i] != tt.want[i] {
					t.Errorf("path %d = %q, want %q", i, got[i], tt.want[i])
				}
			}
			if len(unmapped) != len(tt.wantUnmap) {
				t.Fatalf("unmapped = %v, want %v", unmapped, tt.wantUnmap)
			}
			for i := range unmapped {
				if unmapped[i] != tt.wantUnmap[i] {
					t.Errorf("unmapped = %v, want %v", unmapped, tt.wantUnmap)
				}
			}
		})
	}
}

// TestRewritePathsForVSS_StagingDirStaysMatchableByMarkSystemStateFiles encodes
// the downstream symptom of #3026 rather than only the rewrite itself.
//
// RunBackupContext passes the walked staging root to markSystemStateFiles,
// which prefix-matches it against each collected file's sourcePath. Files under
// the staging dir only ever exist on the live volume, so a shadow-rewritten
// root matched zero of them — SystemStateManifest was set on a snapshot that
// carried none of the artifacts it described. Leaving the index unrewritten is
// what keeps the two ends of that comparison on the same volume.
func TestRewritePathsForVSS_StagingDirStaysMatchableByMarkSystemStateFiles(t *testing.T) {
	const shadowRoot = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`
	const staging = `C:\Windows\Temp\breeze-systemstate-1234`
	shadowPaths := map[string]string{"C:": shadowRoot}

	rewritten, _ := rewritePathsForVSS([]string{`C:\Users\data`, staging}, shadowPaths, 1)
	walkedStagingRoot := rewritten[1]

	// The artifact as it exists on disk — collectSystemState wrote it to the
	// live volume moments ago, after the snapshot was already taken.
	files := []backupFile{{sourcePath: filepath.Join(staging, "registry", "SOFTWARE.hiv")}}
	markSystemStateFiles(files, walkedStagingRoot)

	if !files[0].systemState {
		t.Fatalf("system-state artifact %q was not matched against walked staging root %q — "+
			"the manifest would be recorded with the artifacts missing (#3026)",
			files[0].sourcePath, walkedStagingRoot)
	}
}

// The exclusion must not trade silent data loss for a warning that fires on
// every system_image backup. The staging dir is genuinely a live read, so
// rewritePathsForVSS reports it as unmapped; reportableLiveReads is the layer
// that knows the agent wrote it itself and drops it from the operator-facing
// message. This pins that the two compose.
func TestRewritePathsForVSS_StagingDirIsNotWarnedAsALiveRead(t *testing.T) {
	const shadowRoot = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`
	shadowPaths := map[string]string{"C:": shadowRoot}
	paths := []string{`C:\Users\data`, `C:\Windows\Temp\breeze-systemstate-1234`}

	rewritten, unmapped := rewritePathsForVSS(paths, shadowPaths, 1)

	if got := reportableLiveReads(rewritten, unmapped, 1); len(got) != 0 {
		t.Errorf("reportableLiveReads = %v, want nothing — the staging dir is an expected live read", got)
	}
}

// reportableLiveReads decides which unmapped paths an operator actually hears
// about — the new decision #3025 introduced, alongside the rewrite-side
// exclusion #3026 added above. The caller that uses it
// needs an elevated Windows box and a real VSS provider to reach, so this is
// the level at which that logic can be tested at all. Windows-gated because
// isLocalVolumePath rests on filepath.VolumeName, which is "" for everything
// off-Windows — a portable version would assert nothing.
func TestReportableLiveReads_Selection(t *testing.T) {
	const noStaging = noStagingIdx

	tests := []struct {
		name       string
		paths      []string
		unmapped   []int
		stagingIdx int
		want       []string
	}{
		{
			name:       "reports an unshadowed local volume",
			paths:      []string{`C:\shadowed`, `D:\live`},
			unmapped:   []int{1},
			stagingIdx: noStaging,
			want:       []string{`D:\live`},
		},
		{
			name:       "excludes the system-state staging dir the agent just wrote",
			paths:      []string{`C:\data`, `C:\Windows\Temp\breeze-systemstate-1`},
			unmapped:   []int{1},
			stagingIdx: 1,
			want:       nil,
		},
		{
			// Always unmapped, every run, forever — reporting it would train
			// operators to ignore the warning.
			name:       "excludes UNC paths VSS can never snapshot",
			paths:      []string{`\\server\share\dir`},
			unmapped:   []int{0},
			stagingIdx: noStaging,
			want:       nil,
		},
		{
			name:       "excludes paths with no volume name",
			paths:      []string{`\Data\f.txt`},
			unmapped:   []int{0},
			stagingIdx: noStaging,
			want:       nil,
		},
		{
			name:       "reports the local volume while excluding staging and UNC alongside it",
			paths:      []string{`D:\live`, `\\server\share`, `C:\Windows\Temp\breeze-systemstate-1`},
			unmapped:   []int{0, 1, 2},
			stagingIdx: 2,
			want:       []string{`D:\live`},
		},
		{
			name:       "nothing unmapped reports nothing",
			paths:      []string{`C:\data`},
			unmapped:   nil,
			stagingIdx: noStaging,
			want:       nil,
		},
		{
			// Defensive: a stale index must not panic the run.
			name:       "out-of-range indices are ignored",
			paths:      []string{`C:\data`},
			unmapped:   []int{5, -2},
			stagingIdx: noStaging,
			want:       nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := reportableLiveReads(tt.paths, tt.unmapped, tt.stagingIdx)
			if len(got) != len(tt.want) {
				t.Fatalf("reportableLiveReads = %v, want %v", got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("reportableLiveReads = %v, want %v", got, tt.want)
				}
			}
		})
	}
}

// The summary is promoted into job.Warning, which the IPC result bounding
// truncates and appends to, so it must be capped rather than joined wholesale.
func TestSummarizeLiveReads_CapsTheList(t *testing.T) {
	under := []string{`C:\a`, `D:\b`}
	if got, want := summarizeLiveReads(under), `C:\a; D:\b`; got != want {
		t.Errorf("summarizeLiveReads = %q, want %q", got, want)
	}

	over := make([]string, maxUploadFailureDetails+3)
	for i := range over {
		over[i] = `D:\p` + strconv.Itoa(i)
	}
	got := summarizeLiveReads(over)
	if strings.Contains(got, `D:\p`+strconv.Itoa(maxUploadFailureDetails)) {
		t.Errorf("summary should stop at %d paths, got %q", maxUploadFailureDetails, got)
	}
	if want := fmt.Sprintf("(+%d more)", len(over)-maxUploadFailureDetails); !strings.HasSuffix(got, want) {
		t.Errorf("summary = %q, want it to end with %q", got, want)
	}
}

// TestLive_RewrittenShadowPathReadsExclusivelyLockedFile is the end-to-end
// proof that was missing: it takes a genuinely locked file, rewrites its path
// with the PRODUCTION function against a REAL shadow copy, and reads it back.
//
//	set BREEZE_VSS_LIVE=1 && go test ./internal/backup -run Live -v
func TestLive_RewrittenShadowPathReadsExclusivelyLockedFile(t *testing.T) {
	if os.Getenv("BREEZE_VSS_LIVE") != "1" {
		t.Skip("set BREEZE_VSS_LIVE=1 to run live VSS tests (needs an elevated process)")
	}

	sysRoot := os.Getenv("SystemRoot")
	if sysRoot == "" {
		sysRoot = `C:\Windows`
	}
	vol := filepath.VolumeName(sysRoot)

	dir := filepath.Join(vol+`\`, "breeze-vss-rewrite-test")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	defer os.RemoveAll(dir)

	target := filepath.Join(dir, "locked.txt")
	const payload = "breeze shadow-path rewrite probe"
	if err := os.WriteFile(target, []byte(payload), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	namePtr, err := windows.UTF16PtrFromString(target)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(namePtr, windows.GENERIC_READ|windows.GENERIC_WRITE,
		0 /* no FILE_SHARE_* */, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatalf("exclusive open: %v", err)
	}
	defer windows.CloseHandle(h)

	if _, err := os.ReadFile(target); err == nil {
		t.Skip("file is not actually locked on this system; cannot prove the VSS benefit")
	}

	// Drive the provider through the same entry point backup.go uses, so the
	// volume strings handed to VSS are the ones extractVolumes produces.
	volumes := extractVolumes([]string{dir})
	if len(volumes) != 1 || volumes[0] != vol {
		t.Fatalf("extractVolumes(%q) = %v, want [%q]", dir, volumes, vol)
	}

	p := vss.NewProvider(vss.DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	session, err := p.CreateShadowCopy(ctx, volumes)
	if err != nil {
		t.Fatalf("CreateShadowCopy(%v) failed: %v", volumes, err)
	}
	defer p.ReleaseShadowCopy(session) //nolint:errcheck

	// The production rewrite — not a hand-rolled copy of it.
	rewritten, unmapped := rewritePathsForVSS([]string{target}, session.ShadowPaths, noStagingIdx)
	if len(unmapped) != 0 {
		t.Fatalf("the backup path fell back to the live volume despite an active shadow copy "+
			"(ShadowPaths=%v) — this is the silent #2999 failure mode", session.ShadowPaths)
	}
	if rewritten[0] == target {
		t.Fatalf("path was not rewritten: %q", rewritten[0])
	}

	data, err := os.ReadFile(rewritten[0])
	if err != nil {
		t.Fatalf("reading the locked file through the rewritten shadow path failed: %v", err)
	}
	if string(data) != payload {
		t.Errorf("content = %q, want %q", string(data), payload)
	}
	t.Logf("locked file unreadable directly, read OK through production-rewritten path %s", rewritten[0])
}
