package syscleanup

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const (
	tmutilBinary          = "/usr/bin/tmutil"
	darwinSnapshotTimeout = 10 * time.Minute
	darwinBrewTimeout     = 10 * time.Minute
	darwinEstimateTimeout = 60 * time.Second
)

// startupVolumeMountPoint is the ONLY argument either tmutil invocation takes.
const startupVolumeMountPoint = "/"

func tmutilListSnapshotsArgs() []string {
	return []string{"listlocalsnapshots", startupVolumeMountPoint}
}

// tmutilDeleteSnapshotsArgs uses the MOUNT-POINT form.
//
// `tmutil deletelocalsnapshots <date>` deletes the snapshot bearing that
// timestamp on EVERY mounted APFS volume (spec §13 #11) — on a Mac with its
// Time Machine destination or a cloned backup disk attached, that reaches
// volumes this action was never asked to touch. The mount-point form is
// confined to the startup volume, takes no date at all, and therefore also
// removes the only path by which a parsed string could become an argv token.
func tmutilDeleteSnapshotsArgs() []string {
	return []string{"deletelocalsnapshots", startupVolumeMountPoint}
}

// snapshotDatePattern is deliberately exact: the captured value is passed
// straight back as an argv token, so a line that does not match this shape is
// dropped rather than sanitised.
var snapshotDatePattern = regexp.MustCompile(`^com\.apple\.TimeMachine\.(\d{4}-\d{2}-\d{2}-\d{6})(?:\.local)?$`)

func parseTmutilSnapshots(stdout string) []string {
	dates := make([]string, 0, 8)
	for _, line := range strings.Split(stdout, "\n") {
		if match := snapshotDatePattern.FindStringSubmatch(strings.TrimSpace(line)); match != nil {
			dates = append(dates, match[1])
		}
	}
	return dates
}

var brewFreedPattern = regexp.MustCompile(`This operation would free approximately ([0-9.,]+\s*[kKMGTP]?B) of disk space`)

// parseBrewCleanupDryRun reads the single trailing summary line of
// `brew cleanup --prune=all -n`. brew prints NOTHING at all when there is
// nothing to remove, which is a known zero; an error body is unknown.
func parseBrewCleanupDryRun(output string) (int64, bool) {
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return 0, true
	}
	if match := brewFreedPattern.FindStringSubmatch(trimmed); match != nil {
		return parseDecimalSize(match[1])
	}
	if strings.HasPrefix(trimmed, "Error:") || strings.Contains(trimmed, "Error: ") {
		return 0, false
	}
	// "Would remove:" lines with no summary means brew removed nothing
	// measurable it was willing to total; honest answer is unknown.
	return 0, false
}

// ---------------------------------------------------------------------------
// mac_tm_local_snapshots
// ---------------------------------------------------------------------------

type macSnapshotsAction struct{}

func (macSnapshotsAction) ID() string { return "mac_tm_local_snapshots" }

func (a macSnapshotsAction) Describe() ActionInfo {
	return ActionInfo{
		ID:          a.ID(),
		Label:       "Time Machine local snapshots",
		Description: "Deletes the local APFS snapshots Time Machine keeps on the startup volume. Backups on the Time Machine destination are untouched.",
		OS:          "darwin",
		// Spec §13 #15: on a Mac whose Time Machine destination is not
		// attached, these snapshots are the ONLY on-disk restore points. The
		// original catalogue left that undisclosed.
		RiskFlags:      []string{RiskRemovesRecoveryPoints},
		AffectsVolumes: []string{"/"},
	}
}

func (macSnapshotsAction) Available(context.Context) (bool, string) {
	if _, ok := resolveBinary(tmutilBinary); !ok {
		return false, "tmutil not present"
	}
	return true, ""
}

// Estimate reports the snapshot COUNT in the detail string and leaves bytes
// unknown: macOS exposes no per-snapshot size, and Time Machine's own thinning
// is opportunistic, so any byte figure here would be invented (spec §7.2).
func (macSnapshotsAction) Estimate(ctx context.Context) (int64, bool, string) {
	binary, ok := resolveBinary(tmutilBinary)
	if !ok {
		return 0, false, ""
	}
	proc := runProcess(ctx, darwinEstimateTimeout, binary, tmutilListSnapshotsArgs()...)
	if proc.ExitCode != 0 && proc.Stdout == "" {
		return 0, false, ""
	}
	count := len(parseTmutilSnapshots(proc.Stdout))
	return 0, false, fmt.Sprintf("%d local snapshot(s); macOS does not report their size", count)
}

// Run deletes the startup volume's local snapshots in ONE mount-point-scoped
// invocation.
//
// The per-date loop this replaces was both slower and wrong: each iteration
// passed a bare timestamp, which tmutil applies to every mounted APFS volume
// (spec §13 #11). Listing first is kept only so the result can say how many
// snapshots were present, and so an empty volume is `completed` rather than a
// tmutil error.
func (a macSnapshotsAction) Run(ctx context.Context, _ Params) ActionResult {
	started := time.Now()
	binary, ok := resolveBinary(tmutilBinary)
	if !ok {
		return ActionResult{ID: a.ID(), Status: StatusUnavailable, ExitCode: 1, Error: "tmutil not present"}
	}

	listing := runProcess(ctx, darwinEstimateTimeout, binary, tmutilListSnapshotsArgs()...)
	if listing.Err != nil || listing.ExitCode != 0 || listing.TimedOut {
		// resultFromProc keeps timed_out and failed apart (catalog.go: they
		// call for different next steps).
		result := resultFromProc(a.ID(), listing)
		result.DurationMs = time.Since(started).Milliseconds()
		return result
	}
	before := len(parseTmutilSnapshots(listing.Stdout))
	if before == 0 {
		return ActionResult{ID: a.ID(), Status: StatusCompleted, ExitCode: 0,
			DurationMs: time.Since(started).Milliseconds(), OutputTail: "no local snapshots on the startup volume"}
	}

	proc := runProcess(ctx, darwinSnapshotTimeout, binary, tmutilDeleteSnapshotsArgs()...)
	result := resultFromProc(a.ID(), proc)
	result.DurationMs = time.Since(started).Milliseconds()
	if result.Status == StatusCompleted {
		after := runProcess(ctx, darwinEstimateTimeout, binary, tmutilListSnapshotsArgs()...)
		result.OutputTail = capOutput([]byte(fmt.Sprintf(
			"%d local snapshot(s) before, %d after\n%s",
			before, len(parseTmutilSnapshots(after.Stdout)), proc.Stdout,
		)))
	}
	return result
}

// ---------------------------------------------------------------------------
// mac_brew_cleanup
// ---------------------------------------------------------------------------

type macBrewCleanupAction struct{}

func (macBrewCleanupAction) ID() string { return "mac_brew_cleanup" }

func (a macBrewCleanupAction) Describe() ActionInfo {
	return ActionInfo{
		ID:             a.ID(),
		Label:          "Homebrew cache and old versions",
		Description:    "Runs `brew cleanup --prune=all`: removes downloaded bottles and superseded versions of installed formulae and casks. Installed software stays at its current version.",
		OS:             "darwin",
		RiskFlags:      []string{},
		AffectsVolumes: []string{"/"},
	}
}

func (macBrewCleanupAction) Available(ctx context.Context) (bool, string) {
	if _, err := brewCleanupRun(ctx, true); err != nil {
		return false, "Homebrew is not installed or is not runnable as the console user"
	}
	return true, ""
}

func (macBrewCleanupAction) Estimate(ctx context.Context) (int64, bool, string) {
	output, err := brewCleanupRun(ctx, true)
	if err != nil {
		return 0, false, ""
	}
	bytes, known := parseBrewCleanupDryRun(output)
	if !known {
		return 0, false, ""
	}
	return bytes, true, "brew cleanup --prune=all -n"
}

func (a macBrewCleanupAction) Run(ctx context.Context, _ Params) ActionResult {
	started := time.Now()
	runCtx, cancel := context.WithTimeout(ctx, darwinBrewTimeout)
	defer cancel()

	output, err := brewCleanupRun(runCtx, false)
	result := ActionResult{
		ID:         a.ID(),
		DurationMs: time.Since(started).Milliseconds(),
		OutputTail: capOutput([]byte(output)),
	}
	switch {
	case err != nil && runCtx.Err() == context.DeadlineExceeded:
		result.Status, result.ExitCode, result.Error = StatusTimedOut, 1, err.Error()
	case err != nil:
		result.Status, result.ExitCode, result.Error = StatusFailed, 1, err.Error()
	default:
		result.Status, result.ExitCode = StatusCompleted, 0
	}
	return result
}

func darwinActions() []Action {
	return []Action{macSnapshotsAction{}, macBrewCleanupAction{}}
}
