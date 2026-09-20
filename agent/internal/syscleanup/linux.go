package syscleanup

import (
	"context"
	"fmt"
	"io/fs"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Bounds for the one client-influenced integer. Mirrored by
// packages/shared/src/validators/systemCleanup.ts; clamped again here so a
// forged command payload cannot widen them (spec §5.3, §10 item 7).
const (
	journalVacuumDefaultBytes int64 = 256 << 20
	journalVacuumMinBytes     int64 = 64 << 20
	journalVacuumMaxBytes     int64 = 4 << 30
)

const (
	linuxPkgCleanTimeout      = 5 * time.Minute
	linuxAutoremoveTimeout    = 15 * time.Minute
	linuxJournalVacuumTimeout = 5 * time.Minute
	linuxEstimateTimeout      = 60 * time.Second
)

// linuxPackageManager is the first supported manager present on the host.
type linuxPackageManager struct {
	name   string // apt | dnf | yum
	binary string // absolute path
	cache  string // cache directory, used for the estimate and the write probe
}

var linuxPackageManagerCandidates = []linuxPackageManager{
	{name: "apt", binary: "/usr/bin/apt-get", cache: "/var/cache/apt/archives"},
	{name: "dnf", binary: "/usr/bin/dnf", cache: "/var/cache/dnf"},
	{name: "yum", binary: "/usr/bin/yum", cache: "/var/cache/yum"},
}

const journalctlBinary = "/usr/bin/journalctl"
const journalDirectory = "/var/log/journal"
const dpkgQueryBinary = "/usr/bin/dpkg-query"

// detectPackageManager returns the first candidate whose binary exists. Order
// is apt, dnf, yum — the spec's "first present" (§7.2).
func detectPackageManager() (linuxPackageManager, bool) {
	for _, candidate := range linuxPackageManagerCandidates {
		if path, ok := resolveBinary(candidate.binary); ok {
			candidate.binary = path
			return candidate, true
		}
	}
	return linuxPackageManager{}, false
}

func packageCleanArgs(pm linuxPackageManager) []string {
	if pm.name == "apt" {
		return []string{"clean"}
	}
	return []string{"clean", "all"}
}

func packageAutoremoveArgs(linuxPackageManager) []string { return []string{"-y", "autoremove"} }

func aptAutoremoveSimulateArgs() []string { return []string{"-s", "autoremove"} }

func dnfAutoremoveSimulateArgs() []string { return []string{"--assumeno", "autoremove"} }

func journalDiskUsageArgs() []string { return []string{"--disk-usage"} }

// clampJournalVacuumBytes is the agent-side half of the bound.
func clampJournalVacuumBytes(requested int64) int64 {
	if requested <= 0 {
		return journalVacuumDefaultBytes
	}
	if requested < journalVacuumMinBytes {
		return journalVacuumMinBytes
	}
	if requested > journalVacuumMaxBytes {
		return journalVacuumMaxBytes
	}
	return requested
}

func journalVacuumArgs(requested int64) []string {
	return []string{fmt.Sprintf("--vacuum-size=%d", clampJournalVacuumBytes(requested))}
}

// journalVacuumEstimate is a HEURISTIC, not an upper bound (spec §13 #14):
// journalctl vacuums ARCHIVED files only and rotates on file boundaries, so
// usage-minus-target can be either high (the active journal's share is not
// reclaimable) or low (a rotation during the run frees more). The action
// labels it `heuristic` rather than "up to".
func journalVacuumEstimate(currentUsage, target int64) int64 {
	if delta := currentUsage - target; delta > 0 {
		return delta
	}
	return 0
}

var aptRemvPattern = regexp.MustCompile(`(?m)^Remv\s+(\S+)`)
var aptPlanPattern = regexp.MustCompile(`(?m)^\d+ upgraded, \d+ newly installed, (\d+) to remove`)

// Debian policy §5.6.1. The captured name is handed straight back to
// dpkg-query as an argv token, so anything else is dropped rather than quoted.
var debianPackageNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9+.-]{1,127}$`)
var dnfFreedPattern = regexp.MustCompile(`(?m)^Freed space:\s*([0-9.,]+\s*[KkMGTP]?i?B?)\s*$`)
var journalUsagePattern = regexp.MustCompile(`[Jj]ournals take up ([0-9.,]+\s*[KkMGTP]?i?B?) in the file system`)

// parseAptAutoremovePackages reads the package names from
// `apt-get -s autoremove`.
//
// It does NOT look for "After this operation, X disk space will be freed":
// verified against the APT source (spec §13 #14), that line is emitted by the
// interactive install path and never by `-s`. The original parser looked for
// it, matched nothing on every Debian/Ubuntu endpoint, and — correctly, under
// this package's own "unknown, never 0" rule — would have reported
// estimateKnown:false for the one action whose size a tech most wants to see.
//
// Three distinguishable outcomes:
//   - `Remv` lines -> (names, true)
//   - a plan that removes 0 packages -> ([], true): a KNOWN empty plan
//   - anything else (a lock error, a future format) -> (nil, false)
func parseAptAutoremovePackages(stdout string) ([]string, bool) {
	matches := aptRemvPattern.FindAllStringSubmatch(stdout, -1)
	if len(matches) == 0 {
		if plan := aptPlanPattern.FindStringSubmatch(stdout); plan != nil && plan[1] == "0" {
			return []string{}, true
		}
		return nil, false
	}
	names := make([]string, 0, len(matches))
	for _, match := range matches {
		if debianPackageNamePattern.MatchString(match[1]) {
			names = append(names, match[1])
		}
	}
	return names, true
}

func dpkgQueryInstalledSizeArgs(packages []string) []string {
	return append([]string{"-W", "-f=${Installed-Size}\n"}, packages...)
}

// parseDpkgInstalledSizes sums `dpkg-query -W -f='${Installed-Size}\n'`.
//
// Installed-Size is in KiB (Debian policy §5.6.20), hence the ×1024. The
// result is a HEURISTIC, not an upper bound: unpacked footprint over-counts
// files shared with packages that stay installed, and dpkg rounds to whole
// KiB. The action labels it as such rather than presenting it as "up to".
func parseDpkgInstalledSizes(stdout string) (int64, bool) {
	var total int64
	saw := false
	for _, line := range strings.Split(stdout, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		kib, err := strconv.ParseInt(trimmed, 10, 64)
		if err != nil || kib < 0 {
			return 0, false
		}
		total += kib * 1024
		saw = true
	}
	// No lines at all is only honest for an empty package list; the caller
	// short-circuits that case and never reaches here with real packages.
	_ = saw
	return total, true
}

// parseDnfAutoremoveFreed reads `dnf --assumeno autoremove`'s summary.
//
// dnf exits NON-ZERO when it aborts under --assumeno, so a non-zero exit with
// a parsable summary is success (spec §7.2). dnf5 (Fedora 41+) changed the
// summary shape and is deliberately left unknown until a fixture is added,
// rather than pattern-matched speculatively.
func parseDnfAutoremoveFreed(stdout string, exitCode int) (int64, bool) {
	if exitCode != 0 && exitCode != 1 {
		return 0, false
	}
	match := dnfFreedPattern.FindStringSubmatch(stdout)
	if match == nil {
		if strings.Contains(stdout, "Nothing to do") {
			return 0, true
		}
		return 0, false
	}
	return parseBinarySize(match[1])
}

func parseJournalDiskUsage(stdout string) (int64, bool) {
	match := journalUsagePattern.FindStringSubmatch(stdout)
	if match == nil {
		return 0, false
	}
	return parseBinarySize(match[1])
}

// directorySize sums regular-file sizes under root. Permission errors are
// skipped rather than aborting: a partial figure is still an upper-bound
// estimate, and the estimate is labelled "up to" regardless.
func directorySize(root string) (int64, bool) {
	var total int64
	seen := false
	err := filepath.WalkDir(root, func(_ string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil //nolint:nilerr // unreadable subtree: skip, do not abort
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil //nolint:nilerr
		}
		seen = true
		total += info.Size()
		return nil
	})
	if err != nil {
		return 0, false
	}
	return total, seen || total == 0
}

// ---------------------------------------------------------------------------
// linux_pkg_cache_clean
// ---------------------------------------------------------------------------

type linuxPkgCacheCleanAction struct{}

func (linuxPkgCacheCleanAction) ID() string { return "linux_pkg_cache_clean" }

func (a linuxPkgCacheCleanAction) Describe() ActionInfo {
	return ActionInfo{
		ID:             a.ID(),
		Label:          "Package manager cache",
		Description:    "Removes downloaded package archives that apt, dnf or yum keep after installing. Packages already installed are untouched; anything removed is re-downloadable.",
		OS:             "linux",
		RiskFlags:      []string{},
		AffectsVolumes: []string{"/"},
	}
}

func (linuxPkgCacheCleanAction) Available(context.Context) (bool, string) {
	pm, ok := detectPackageManager()
	if !ok {
		return false, "no supported package manager (apt, dnf, yum) found"
	}
	return probeWritable(pm.cache)
}

func (linuxPkgCacheCleanAction) Estimate(context.Context) (int64, bool, string) {
	pm, ok := detectPackageManager()
	if !ok {
		return 0, false, ""
	}
	size, known := directorySize(pm.cache)
	if !known {
		return 0, false, ""
	}
	return size, true, fmt.Sprintf("size of %s", pm.cache)
}

func (a linuxPkgCacheCleanAction) Run(ctx context.Context, _ Params) ActionResult {
	pm, ok := detectPackageManager()
	if !ok {
		return ActionResult{ID: a.ID(), Status: StatusUnavailable, ExitCode: 1,
			Error: "no supported package manager (apt, dnf, yum) found"}
	}
	return resultFromProc(a.ID(), runProcess(ctx, linuxPkgCleanTimeout, pm.binary, packageCleanArgs(pm)...))
}

// ---------------------------------------------------------------------------
// linux_pkg_autoremove
// ---------------------------------------------------------------------------

type linuxPkgAutoremoveAction struct{}

func (linuxPkgAutoremoveAction) ID() string { return "linux_pkg_autoremove" }

func (a linuxPkgAutoremoveAction) Describe() ActionInfo {
	return ActionInfo{
		ID:             a.ID(),
		Label:          "Remove orphaned packages",
		Description:    "Removes packages that were installed only as dependencies and are no longer required — most often superseded kernels. This uninstalls software.",
		OS:             "linux",
		RiskFlags:      []string{RiskRemovesPackages},
		AffectsVolumes: []string{"/"},
	}
}

func (linuxPkgAutoremoveAction) Available(context.Context) (bool, string) {
	pm, ok := detectPackageManager()
	if !ok {
		return false, "no supported package manager (apt, dnf, yum) found"
	}
	if pm.name == "yum" {
		// `yum autoremove` exists but has no non-mutating simulation mode with
		// a machine-readable summary, so it is offered without an estimate
		// rather than with a fabricated one.
		return true, ""
	}
	return probeWritable(pm.cache)
}

func (linuxPkgAutoremoveAction) Estimate(ctx context.Context) (int64, bool, string) {
	pm, ok := detectPackageManager()
	if !ok {
		return 0, false, ""
	}
	switch pm.name {
	case "apt":
		proc := runProcess(ctx, linuxEstimateTimeout, pm.binary, aptAutoremoveSimulateArgs()...)
		packages, known := parseAptAutoremovePackages(proc.Stdout)
		if !known {
			return 0, false, ""
		}
		if len(packages) == 0 {
			return 0, true, "apt-get -s autoremove: nothing to remove"
		}
		dpkg, ok := resolveBinary(dpkgQueryBinary)
		if !ok {
			return 0, false, ""
		}
		sizes := runProcess(ctx, linuxEstimateTimeout, dpkg, dpkgQueryInstalledSizeArgs(packages)...)
		bytes, sizesKnown := parseDpkgInstalledSizes(sizes.Stdout)
		if !sizesKnown {
			return 0, false, ""
		}
		return bytes, true, fmt.Sprintf("heuristic: installed size of %d package(s) apt would remove", len(packages))
	case "dnf":
		proc := runProcess(ctx, linuxEstimateTimeout, pm.binary, dnfAutoremoveSimulateArgs()...)
		bytes, known := parseDnfAutoremoveFreed(proc.Stdout, proc.ExitCode)
		if !known {
			return 0, false, ""
		}
		return bytes, true, "dnf --assumeno autoremove"
	default:
		return 0, false, ""
	}
}

func (a linuxPkgAutoremoveAction) Run(ctx context.Context, _ Params) ActionResult {
	pm, ok := detectPackageManager()
	if !ok {
		return ActionResult{ID: a.ID(), Status: StatusUnavailable, ExitCode: 1,
			Error: "no supported package manager (apt, dnf, yum) found"}
	}
	return resultFromProc(a.ID(), runProcess(ctx, linuxAutoremoveTimeout, pm.binary, packageAutoremoveArgs(pm)...))
}

// ---------------------------------------------------------------------------
// linux_journal_vacuum
// ---------------------------------------------------------------------------

type linuxJournalVacuumAction struct{}

func (linuxJournalVacuumAction) ID() string { return "linux_journal_vacuum" }

func (a linuxJournalVacuumAction) Describe() ActionInfo {
	return ActionInfo{
		ID:             a.ID(),
		Label:          "Trim systemd journal",
		Description:    "Vacuums archived systemd journal files down to the selected size. The active journal is never touched, so recent logs are preserved.",
		OS:             "linux",
		RiskFlags:      []string{},
		AffectsVolumes: []string{"/"},
	}
}

func (linuxJournalVacuumAction) Available(context.Context) (bool, string) {
	if _, ok := resolveBinary(journalctlBinary); !ok {
		return false, "journalctl not present"
	}
	return probeWritable(journalDirectory)
}

func (linuxJournalVacuumAction) Estimate(ctx context.Context) (int64, bool, string) {
	binary, ok := resolveBinary(journalctlBinary)
	if !ok {
		return 0, false, ""
	}
	proc := runProcess(ctx, linuxEstimateTimeout, binary, journalDiskUsageArgs()...)
	// journalctl writes the usage line to stdout, but some builds put it on
	// stderr; check both rather than depending on which.
	usage, known := parseJournalDiskUsage(proc.Stdout)
	if !known {
		usage, known = parseJournalDiskUsage(proc.Stderr)
	}
	if !known {
		return 0, false, ""
	}
	return journalVacuumEstimate(usage, journalVacuumDefaultBytes), true,
		"heuristic: journalctl --disk-usage minus the vacuum target; only archived journals are vacuumed"
}

func (a linuxJournalVacuumAction) Run(ctx context.Context, params Params) ActionResult {
	binary, ok := resolveBinary(journalctlBinary)
	if !ok {
		return ActionResult{ID: a.ID(), Status: StatusUnavailable, ExitCode: 1, Error: "journalctl not present"}
	}
	return resultFromProc(a.ID(), runProcess(ctx, linuxJournalVacuumTimeout, binary, journalVacuumArgs(params.JournalVacuumBytes)...))
}

// linuxActions is the linux half of the catalogue, in execution order.
func linuxActions() []Action {
	return []Action{
		linuxPkgCacheCleanAction{},
		linuxPkgAutoremoveAction{},
		linuxJournalVacuumAction{},
	}
}

// resultFromProc turns one process invocation into an ActionResult. Shared by
// every single-process action on all three platforms.
func resultFromProc(id string, proc ProcResult) ActionResult {
	result := ActionResult{
		ID:         id,
		ExitCode:   proc.ExitCode,
		DurationMs: proc.Duration.Milliseconds(),
		OutputTail: strings.TrimSpace(proc.Stdout + "\n" + proc.Stderr),
	}
	switch {
	case proc.TimedOut:
		result.Status = StatusTimedOut
		result.Error = proc.Err.Error()
	case proc.Err != nil:
		result.Status = StatusFailed
		result.Error = proc.Err.Error()
	case proc.ExitCode != 0:
		result.Status = StatusFailed
		result.Error = fmt.Sprintf("%s exited with code %d", filepath.Base(proc.Path), proc.ExitCode)
	default:
		result.Status = StatusCompleted
	}
	return result
}
