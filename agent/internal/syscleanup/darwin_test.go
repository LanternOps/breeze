package syscleanup

import (
	"context"
	"regexp"
	"strings"
	"testing"
)

// Two independent constraints, and the second is the one plan amendment 21
// (spec §13 #11) added:
//   - `thinlocalsnapshots` is OPPORTUNISTIC and may delete nothing, so it is
//     never used;
//   - `deletelocalsnapshots <date>` deletes that timestamp's snapshot on EVERY
//     mounted APFS volume, which on a Mac with its Time Machine disk attached
//     reaches the backup destination. The MOUNT-POINT form is scoped to the
//     startup volume, and is also what `listlocalsnapshots /` enumerates.
func TestTmutilArgsAreMountPointScoped(t *testing.T) {
	if got := strings.Join(tmutilListSnapshotsArgs(), " "); got != "listlocalsnapshots /" {
		t.Fatalf("tmutilListSnapshotsArgs() = %q", got)
	}
	if got := strings.Join(tmutilDeleteSnapshotsArgs(), " "); got != "deletelocalsnapshots /" {
		t.Fatalf("tmutilDeleteSnapshotsArgs() = %q, want the mount-point form", got)
	}
	for _, args := range [][]string{tmutilListSnapshotsArgs(), tmutilDeleteSnapshotsArgs()} {
		for _, arg := range args {
			if arg == "thinlocalsnapshots" {
				t.Fatalf("args %v use the opportunistic thinning command", args)
			}
			// A bare date would be machine-wide. The only argument either
			// invocation may carry is the mount point.
			if regexp.MustCompile(`^\d{4}-\d{2}-\d{2}-\d{6}$`).MatchString(arg) {
				t.Fatalf("args %v pass a bare snapshot date, which deletes on every mounted volume", args)
			}
		}
	}
}

func TestParseTmutilSnapshots(t *testing.T) {
	const fixture = `Snapshots for volume group containing disk /:
com.apple.TimeMachine.2026-09-17-031500.local
com.apple.TimeMachine.2026-09-18-084500.local
com.apple.TimeMachine.2026-09-19-104500.local
`
	got := parseTmutilSnapshots(fixture)
	want := []string{"2026-09-17-031500", "2026-09-18-084500", "2026-09-19-104500"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("parseTmutilSnapshots() = %v, want %v", got, want)
	}
}

// Only the date is extracted, and only in the exact shape tmutil emits — the
// value is passed straight back as an argv token, so anything else is dropped.
func TestParseTmutilSnapshotsRejectsAnythingUnexpected(t *testing.T) {
	const hostile = `Snapshots for disk /:
com.apple.TimeMachine.2026-09-19-104500.local
com.apple.TimeMachine.; rm -rf /.local
com.apple.TimeMachine.../../etc.local
not a snapshot line
`
	got := parseTmutilSnapshots(hostile)
	if len(got) != 1 || got[0] != "2026-09-19-104500" {
		t.Fatalf("parseTmutilSnapshots() = %v, want only the well-formed date", got)
	}
}

func TestParseTmutilSnapshotsOnNoSnapshots(t *testing.T) {
	if got := parseTmutilSnapshots("Snapshots for volume group containing disk /:\n"); len(got) != 0 {
		t.Fatalf("parseTmutilSnapshots() = %v, want empty", got)
	}
}

// `brew cleanup -n` prints one line per file it WOULD remove and a single
// trailing summary; only the summary is parsed (spec §7.2, Codex correction).
func TestParseBrewCleanupDryRun(t *testing.T) {
	const fixture = `Would remove: /Users/t/Library/Caches/Homebrew/node--21.7.1.bottle.tar.gz (48.6MB)
Would remove: /opt/homebrew/Cellar/ripgrep/14.1.0 (5.2MB)
==> This operation would free approximately 1.2GB of disk space.
`
	got, ok := parseBrewCleanupDryRun(fixture)
	if !ok || got != 1_200_000_000 {
		t.Fatalf("parseBrewCleanupDryRun() = (%d, %v), want (1200000000, true)", got, ok)
	}
}

func TestParseBrewCleanupDryRunOnNothingToDo(t *testing.T) {
	got, ok := parseBrewCleanupDryRun("")
	if !ok || got != 0 {
		t.Fatalf("parseBrewCleanupDryRun(\"\") = (%d, %v), want (0, true) — brew prints nothing when there is nothing to remove", got, ok)
	}
	if _, ok := parseBrewCleanupDryRun("Error: Another active Homebrew process is already running.\n"); ok {
		t.Fatal("an error body must be estimateKnown:false, not 0")
	}
}

func TestDarwinActionsShape(t *testing.T) {
	byID := map[string]ActionInfo{}
	for _, action := range darwinActions() {
		byID[action.ID()] = action.Describe()
	}
	for _, id := range []string{"mac_tm_local_snapshots", "mac_brew_cleanup"} {
		info, ok := byID[id]
		if !ok {
			t.Fatalf("darwinActions() is missing %q", id)
		}
		if info.OS != "darwin" || info.Label == "" || info.Description == "" {
			t.Errorf("%s: %+v", id, info)
		}
		if containsFold(info.RiskFlags, RiskRemovesPackages) {
			t.Errorf("%s must not carry removes_packages", id)
		}
	}
}

func TestSnapshotListingCancellationIsFailed(t *testing.T) {
	if _, ok := resolveBinary(tmutilBinary); !ok {
		t.Skip("tmutil is not installed on this platform")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result := (macSnapshotsAction{}).Run(ctx, Params{})
	if result.Status != StatusFailed || result.Error == "" {
		t.Fatalf("failed snapshot listing reported %+v", result)
	}
}
