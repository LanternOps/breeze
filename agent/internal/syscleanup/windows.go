package syscleanup

import (
	"context"
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// The Windows-only seam, indirected through function VARIABLES so the profile
// hygiene rules (spec §13 #4) are testable on the Linux CI runner — the
// Windows `go test` job does not run internal/syscleanup at all, so a
// registry-shaped fake here is the only place those rules are ever executed.
var (
	presentVolumeCaches  = presentVolumeCachesImpl
	setStateFlags        = setStateFlagsImpl
	handlerDisplayName   = handlerDisplayNameImpl
	expandWindowsPath    = expandWindowsPathImpl
	readDOCachePolicy    = readDOCachePolicyImpl
	resolveWindowsBinary = resolveBinary
	runWindowsProcess    = runProcess
	// cleanmgr gets the idle-watchdog entry point (#6482); every other Windows
	// cleaner exits on its own and uses the plain one.
	runWindowsProcessIdle = runProcessIdle
)

const (
	volumeCachesKey = `SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VolumeCaches`
	doPolicyKey     = `SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization`
	doPolicyValue   = "DOModifyCacheDrive"
	stateFlagsValue = "StateFlags5555"

	cleanmgrBinaryRelative = `\System32\cleanmgr.exe`
	dismBinaryRelative     = `\System32\dism.exe`

	cleanmgrTimeout      = 60 * time.Minute
	dismCleanupTimeout   = 90 * time.Minute
	windowsEstimateLimit = 3 * time.Minute
)

// cleanmgrIdleLimits ends a wedged session-0 Disk Cleanup long before the
// 60-minute cap (#6482).
//
// The numbers are deliberately loose. cleanmgr's handlers are file deletions,
// which accrue kernel time continuously while they run, so a tree that has not
// moved the job object's CPU total by a quarter of a second in five straight
// minutes is not working — it is sitting on the invisible session-0 desktop
// waiting for a dismissal that will never come. The one-minute grace period
// covers a slow start (the handler enumeration on a large WinSxS), and the
// 60-minute cap stays as the backstop for a host where the job object could
// not be created and the watchdog is therefore off.
var cleanmgrIdleLimits = idleLimits{
	sample:    15 * time.Second,
	minRun:    time.Minute,
	idleAfter: 5 * time.Minute,
	noise:     250 * time.Millisecond,
}

// cleanmgrIdleNote is what the tech reads in outputTail when the watchdog
// ended the run. It must say what happened without implying a failure: the
// handlers did their work, cleanmgr merely never exits.
const cleanmgrIdleNote = "Disk Cleanup finished its handlers but never exits under the SYSTEM service " +
	"(it waits on a progress window that session 0 cannot show); its process tree was terminated once it stopped using CPU."

// winCleanmgrHandler is one allowlisted cleanmgr handler.
//
// `slug` is the only token the server and the UI ever see; `keyName` is the
// registry sub-key, which is NEVER accepted from the wire. `estimatePaths` are
// the directories whose size stands in for the handler's reclaimable space
// where one is known (spec §7.2); an empty list means the handler is opaque
// and reports estimateKnown:false.
type winCleanmgrHandler struct {
	slug      string
	keyName   string
	label     string
	riskFlags []string
	// estimatePaths are static, environment-expanded directories.
	estimatePaths []string
	// estimatePathsFn resolves paths that depend on machine state — today only
	// the Delivery Optimization cache, whose location is policy-overridable
	// (spec §13 #14). Nil for every other handler.
	estimatePathsFn func() []string
}

// The allowlist from spec §7.2, verbatim. Anything else under VolumeCaches is
// never offered. The four deliberate exclusions — DownloadsFolder (user data),
// Windows ESD installation files (breaks Reset this PC), Language Pack
// (uninstalls languages) and every per-user handler (under the SYSTEM service
// account they operate on the SYSTEM profile, and the file engine already
// covers user bins) — are absent by construction and asserted absent by test.
var winCleanmgrHandlers = []winCleanmgrHandler{
	{slug: "delivery_optimization_files", keyName: "Delivery Optimization Files", label: "Delivery Optimization files",
		estimatePathsFn: func() []string { return []string{deliveryOptimizationCachePath(readDOCachePolicy())} }},
	{slug: "device_driver_packages", keyName: "Device Driver Packages", label: "Device driver packages",
		riskFlags: []string{RiskRemovesDriverRollback}},
	{slug: "previous_installations", keyName: "Previous Installations", label: "Previous Windows installations",
		riskFlags:     []string{RiskRemovesOSRollback},
		estimatePaths: []string{`%SystemDrive%\Windows.old`}},
	{slug: "upgrade_discarded_files", keyName: "Upgrade Discarded Files", label: "Discarded upgrade files",
		riskFlags:     []string{RiskRemovesOSRollback},
		estimatePaths: []string{`%SystemDrive%\$WINDOWS.~BT`, `%SystemDrive%\$WINDOWS.~WS`}},
	{slug: "windows_upgrade_log_files", keyName: "Windows Upgrade Log Files", label: "Windows upgrade log files",
		estimatePaths: []string{`%SystemDrive%\$Windows.~BT\Sources\Panther`, `%SystemRoot%\Panther`}},
	{slug: "setup_log_files", keyName: "Setup Log Files", label: "Setup log files",
		estimatePaths: []string{`%SystemRoot%\Logs`}},
	{slug: "temporary_setup_files", keyName: "Temporary Setup Files", label: "Temporary setup files"},
	{slug: "service_pack_cleanup", keyName: "Service Pack Cleanup", label: "Service pack backup files"},
	{slug: "system_error_memory_dump_files", keyName: "System error memory dump files", label: "System error memory dumps",
		estimatePaths: []string{`%SystemRoot%\MEMORY.DMP`}},
	{slug: "system_error_minidump_files", keyName: "System error minidump files", label: "System error minidumps",
		estimatePaths: []string{`%SystemRoot%\Minidump`}},
	{slug: "windows_error_reporting_files", keyName: "Windows Error Reporting Files", label: "Error reporting files"},
	{slug: "windows_error_reporting_system_archive_files", keyName: "Windows Error Reporting System Archive Files", label: "Error reporting archive"},
	{slug: "windows_error_reporting_system_queue_files", keyName: "Windows Error Reporting System Queue Files", label: "Error reporting queue"},
	// No estimatePaths on purpose (spec §13 #14): under the SYSTEM account the
	// handler covers %SystemRoot%\Temp AND the service profiles' temp
	// directories, so sizing it from one directory under-reports. An honest
	// "size unknown" beats a confidently low number.
	{slug: "temporary_files", keyName: "Temporary Files", label: "Temporary files"},
	{slug: "windows_defender", keyName: "Windows Defender", label: "Microsoft Defender scan history",
		estimatePaths: []string{`%ProgramData%\Microsoft\Windows Defender\Scans\History`}},
	{slug: "old_chkdsk_files", keyName: "Old ChkDsk Files", label: "Old ChkDsk fragments"},
	{slug: "diagnostic_data_viewer_database_files", keyName: "Diagnostic Data Viewer database files", label: "Diagnostic Data Viewer database"},
	{slug: "branchcache", keyName: "BranchCache", label: "BranchCache"},
	{slug: "content_indexer_cleaner", keyName: "Content Indexer Cleaner", label: "Search index fragments"},
}

// winRetiredCleanmgrHandlers are allowlist slugs Breeze no longer OFFERS, kept
// as recognised ids so an older saved selection is answered with a reason
// rather than a validation error (#6482).
//
// `update_cleanup` is the one entry. Under the SYSTEM service its handler
// deadlocks inside DismGetUsedSpaceInternal — the size query it makes BEFORE
// deleting anything — so unlike every other handler it wedges without doing
// any work at all: three of three W05 lab runs freed nothing and had to be
// killed. `win_dism_component_cleanup` (DISM /StartComponentCleanup) is the
// supported non-interactive form of the same component-store cleanup and
// completed in 7.6 s on the same rig, so nothing is lost by retiring it.
var winRetiredCleanmgrHandlers = map[string]string{
	"update_cleanup": "Windows Update cleanup cannot run under the SYSTEM service: cleanmgr's " +
		"Update Cleanup handler deadlocks in session 0 before it frees anything. " +
		"Use the win_dism_component_cleanup action, which performs the same component-store cleanup.",
}

// paths returns the directories whose size stands in for this handler, static
// and runtime-resolved alike. Empty means "opaque" — the handler reports
// estimateKnown:false rather than a number it cannot stand behind.
func (h winCleanmgrHandler) paths() []string {
	if h.estimatePathsFn != nil {
		return h.estimatePathsFn()
	}
	return h.estimatePaths
}

func winCleanmgrHandlerBySubID(subID string) (winCleanmgrHandler, bool) {
	slug := strings.TrimPrefix(subID, "win_cleanmgr:")
	if slug == subID {
		return winCleanmgrHandler{}, false
	}
	for _, handler := range winCleanmgrHandlers {
		if handler.slug == slug {
			return handler, true
		}
	}
	return winCleanmgrHandler{}, false
}

// defaultDOCachePath is where Delivery Optimization keeps its cache when no
// policy moves it (spec §13 #14). NOT under SoftwareDistribution, which is
// where the original plan looked and where nothing DO-related lives.
const defaultDOCachePath = `%SystemDrive%\Windows\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache`

// deliveryOptimizationCachePath applies the DOModifyCacheDrive policy value.
//
// The policy accepts either a bare drive ("E:") or an explicit folder
// ("D:\DOCache"). A drive letter keeps the default tail; a folder is used
// verbatim. Pure, so the three cases are table-tested on any host.
func deliveryOptimizationCachePath(policyValue string) string {
	trimmed := strings.TrimSpace(policyValue)
	if trimmed == "" {
		return defaultDOCachePath
	}
	if regexp.MustCompile(`^[A-Za-z]:\\?$`).MatchString(trimmed) {
		drive := strings.TrimSuffix(trimmed, `\`)
		return drive + `\Windows\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache`
	}
	return strings.TrimSuffix(trimmed, `\`)
}

func cleanmgrArgs() []string { return []string{"/sagerun:5555"} }

// /English FIRST: DISM's output is localised, and every field
// parseDismAnalyze looks for is an English literal (spec §7.1).
func dismAnalyzeArgs() []string {
	return []string{"/English", "/Online", "/Cleanup-Image", "/AnalyzeComponentStore"}
}

// StartComponentCleanup only. /ResetBase makes every installed update
// permanent and is out of scope by design (spec §1, §10 item 7).
func dismCleanupArgs() []string {
	return []string{"/English", "/Online", "/Cleanup-Image", "/StartComponentCleanup"}
}

func systemRoot() string {
	if root := os.Getenv("SystemRoot"); root != "" {
		return root
	}
	return `C:\Windows`
}

// DISM reports 1024-based sizes with a two-character suffix ("1.64 GB"), which
// matches neither apt's 1000-based grammar nor dnf's single-letter one.
var dismSizePattern = regexp.MustCompile(`^([0-9]+(?:\.[0-9]+)?)\s*(bytes|KB|MB|GB|TB)$`)

var dismUnitFactor = map[string]float64{
	"bytes": 1, "KB": 1 << 10, "MB": 1 << 20, "GB": 1 << 30, "TB": 1 << 40,
}

func parseDismSize(text string) (int64, bool) {
	match := dismSizePattern.FindStringSubmatch(strings.TrimSpace(text))
	if match == nil {
		return 0, false
	}
	amount, err := strconv.ParseFloat(match[1], 64)
	if err != nil || amount < 0 {
		return 0, false
	}
	bytes := amount * dismUnitFactor[match[2]]
	if bytes > float64(math.MaxInt64) {
		return 0, false
	}
	return int64(math.Round(bytes)), true
}

var dismBackupsPattern = regexp.MustCompile(`Backups and Disabled Features\s*:\s*([0-9.]+\s*(?:bytes|KB|MB|GB|TB))`)
var dismCachePattern = regexp.MustCompile(`Cache and Temporary Data\s*:\s*([0-9.]+\s*(?:bytes|KB|MB|GB|TB))`)
var dismRecommendedNoPattern = regexp.MustCompile(`Component Store Cleanup Recommended\s*:\s*No`)

// parseDismAnalyze sums the two reclaimable fields of AnalyzeComponentStore
// and reports whether Windows recommends the cleanup.
//
// The figure is a HEURISTIC, not an upper bound (spec §13 #14). The original
// plan called it an upper bound on the strength of a 30-day grace period that
// does not apply here: that grace belongs to the SCHEDULED
// StartComponentCleanup task, not to the explicit invocation this action
// makes. The two fields are component-store *overhead*, which can be more or
// less than what the run actually frees.
//
// `Component Store Cleanup Recommended : No` is NOT a zero either — it means
// Windows does not think the cleanup is worth doing, which is a different
// claim from "nothing would be freed". The sum is reported in both cases and
// the recommendation rides alongside it so the UI can say so.
//
// An unrecognised body is unknown, never 0.
func parseDismAnalyze(stdout string) (bytes int64, known bool, recommended bool) {
	backups := dismBackupsPattern.FindStringSubmatch(stdout)
	cache := dismCachePattern.FindStringSubmatch(stdout)
	if backups == nil || cache == nil {
		return 0, false, false
	}
	backupBytes, backupOK := parseDismSize(backups[1])
	cacheBytes, cacheOK := parseDismSize(cache[1])
	if !backupOK || !cacheOK {
		return 0, false, false
	}
	return backupBytes + cacheBytes, true, !dismRecommendedNoPattern.MatchString(stdout)
}

// ---------------------------------------------------------------------------
// win_cleanmgr
// ---------------------------------------------------------------------------

type winCleanmgrAction struct {
	// selectedSlugs is empty for the catalogue listing and for a bare
	// `win_cleanmgr` selection, which means "every allowlisted handler present
	// on this device".
	selectedSlugs []string
}

func (winCleanmgrAction) ID() string { return "win_cleanmgr" }

func (a winCleanmgrAction) Describe() ActionInfo {
	return ActionInfo{
		ID:             a.ID(),
		Label:          "Windows Disk Cleanup",
		Description:    "Runs the built-in Disk Cleanup handlers you select. Downloads, per-user caches, recovery images and language packs are never offered.",
		OS:             "windows",
		RiskFlags:      []string{RiskLongRunning},
		AffectsVolumes: []string{},
	}
}

func (winCleanmgrAction) Available(context.Context) (bool, string) {
	if _, ok := resolveWindowsBinary(systemRoot() + cleanmgrBinaryRelative); !ok {
		return false, "cleanmgr.exe not present"
	}
	if _, err := presentVolumeCaches(); err != nil {
		return false, "Disk Cleanup handlers are not registered on this build"
	}
	return true, ""
}

// Estimate is the sum of the known handler directories; handlers with no known
// directory (Temporary Files above all) contribute nothing, so the total is a
// lower bound on an upper bound and is presented as "up to".
func (a winCleanmgrAction) Estimate(context.Context) (int64, bool, string) {
	var total int64
	known := false
	for _, handler := range a.availableHandlers() {
		for _, path := range handler.paths() {
			size, ok := directorySize(expandWindowsPath(path))
			if !ok {
				continue
			}
			total += size
			known = true
		}
	}
	if !known {
		return 0, false, ""
	}
	return total, true, "sum of the handler directories whose location is known; opaque handlers are not counted"
}

// availableHandlers intersects the allowlist with the handlers this build
// actually registers.
func (a winCleanmgrAction) availableHandlers() []winCleanmgrHandler {
	present, err := presentVolumeCaches()
	if err != nil {
		return nil
	}
	presentSet := make(map[string]bool, len(present))
	for _, name := range present {
		presentSet[strings.ToLower(name)] = true
	}
	selected := make(map[string]bool, len(a.selectedSlugs))
	for _, slug := range a.selectedSlugs {
		selected[slug] = true
	}

	out := make([]winCleanmgrHandler, 0, len(winCleanmgrHandlers))
	for _, handler := range winCleanmgrHandlers {
		if !presentSet[strings.ToLower(handler.keyName)] {
			continue
		}
		if len(selected) > 0 && !selected[handler.slug] {
			continue
		}
		out = append(out, handler)
	}
	return out
}

// SubActions is the catalogue's per-handler listing, with the localised label
// where SHLoadIndirectString could resolve one and the fixed friendly label
// otherwise.
func (a winCleanmgrAction) SubActions() []SubActionInfo {
	all := winCleanmgrAction{}.availableHandlers()
	out := make([]SubActionInfo, 0, len(all))
	for _, handler := range all {
		label := handlerDisplayName(handler.keyName)
		if label == "" {
			label = handler.label
		}
		info := SubActionInfo{ID: "win_cleanmgr:" + handler.slug, Label: label, RiskFlags: append([]string{}, handler.riskFlags...)}
		for _, path := range handler.paths() {
			if size, ok := directorySize(expandWindowsPath(path)); ok {
				info.EstimateBytes += size
				info.EstimateKnown = true
			}
		}
		out = append(out, info)
	}
	return out
}

// Run rewrites the ENTIRE StateFlags5555 profile, then runs cleanmgr
// /sagerun:5555.
//
// Profile hygiene (spec §13 #4) is the safety-critical part, and it is why
// this writes 0 to **every** VolumeCaches subkey rather than only to the
// allowlisted ones it did not select:
//
//   - `/sagerun:5555` executes every handler whose StateFlags5555 is 2,
//     wherever that value came from. A third-party cleanup handler, an OEM
//     one, or an excluded built-in (DownloadsFolder) that already carries a 2
//     — set by another tool, by a prior Breeze run, or by a user who once ran
//     `cleanmgr /sageset:5555` — would run alongside the selection with no
//     trace in the result. The allowlist constrains what Breeze may SELECT; it
//     cannot constrain what the shared profile already says.
//   - Any write failure aborts BEFORE cleanmgr starts. A half-written profile
//     is worse than no run: it executes an arbitrary subset that matches
//     neither what the tech chose nor what the result will claim.
//   - Nothing is restored afterwards. Profile 5555 is Breeze-owned by
//     convention, the next run rewrites it wholesale, and "restoring" a
//     profile another tool may have edited concurrently would be a second
//     guess at state we do not own.
//
// HKLM\SOFTWARE\...\VolumeCaches is trusted as admin-only: a caller who can
// write there can already run cleanmgr directly. Handler key names are treated
// as LABELS, not as authenticity — the allowlist is a list of things Breeze
// offers, not proof that a key of that name is the Microsoft handler.
//
// Session-0 caveat (spec §7.2, measured in W05 and fixed in #6482): under the
// SYSTEM account cleanmgr renders a progress UI onto session 0's invisible
// desktop and never exits — 3 of 3 lab runs sat at ~0.2 s of CPU for the whole
// 60-minute cap with the file work already done. The runner therefore waits on
// the whole process tree (the job object in process_tree_windows.go), treats
// the exit code as INFORMATIONAL ONLY, and arms the idle watchdog
// (cleanmgrIdleLimits): once the tree's CPU total has been flat for five
// minutes it is terminated and the run reports `completed` with
// cleanmgrIdleNote, because a cleanmgr that has stopped working has finished
// its handlers. The 60-minute cap stays as the backstop for hosts where the
// job object could not be created, and that path still reports timed_out.
//
// Whatever the outcome, cleanmgr reports NOTHING per handler, so every
// sub-action carries the parent's status rather than a `completed` nobody
// verified (W05 BUG-3). The acceptance criterion for this action is the lab
// run, not a unit test — nothing here can prove session-0 behaviour.
//
// The process-wide maintenance lock is held by the RUN (catalog.go), not
// acquired here: two runs rewriting this one shared profile is exactly the
// interleaving that lock exists to prevent.
func (a winCleanmgrAction) Run(ctx context.Context, _ Params) ActionResult {
	started := time.Now()
	binary, ok := resolveWindowsBinary(systemRoot() + cleanmgrBinaryRelative)
	if !ok {
		return ActionResult{ID: a.ID(), Status: StatusUnavailable, ExitCode: 1, Error: "cleanmgr.exe not present"}
	}

	// A retired handler is answered before anything is written: it is not just
	// "not selected", it is a handler that would wedge the whole run (#6482).
	retired := make([]SubActionRun, 0, len(a.selectedSlugs))
	retiredReasons := make([]string, 0, len(a.selectedSlugs))
	for _, slug := range a.selectedSlugs {
		if reason, ok := winRetiredCleanmgrHandlers[slug]; ok {
			retired = append(retired, SubActionRun{ID: "win_cleanmgr:" + slug, Status: StatusUnavailable})
			retiredReasons = append(retiredReasons, reason)
		}
	}

	selected := a.availableHandlers()
	if len(selected) == 0 {
		if len(retired) > 0 {
			return ActionResult{ID: a.ID(), Status: StatusUnavailable, ExitCode: 1,
				SubActions: retired,
				DurationMs: time.Since(started).Milliseconds(),
				Error:      strings.Join(retiredReasons, " ")}
		}
		return ActionResult{ID: a.ID(), Status: StatusUnavailable, ExitCode: 1,
			Error: "none of the selected Disk Cleanup handlers are registered on this build"}
	}
	selectedSet := make(map[string]bool, len(selected))
	for _, handler := range selected {
		selectedSet[handler.keyName] = true
	}

	present, err := presentVolumeCaches()
	if err != nil {
		return ActionResult{ID: a.ID(), Status: StatusFailed, ExitCode: 1,
			DurationMs: time.Since(started).Milliseconds(),
			Error:      fmt.Sprintf("could not enumerate the Disk Cleanup handlers: %v", err)}
	}

	// Pass 1: write the whole profile. EVERY subkey on the machine, not just
	// the allowlisted ones.
	zeroed := 0
	for _, keyName := range present {
		value := uint32(0)
		if selectedSet[keyName] {
			value = 2
		}
		if err := setStateFlags(keyName, value); err != nil {
			// Abort before cleanmgr runs. See the profile-hygiene note above:
			// a partially written profile executes an arbitrary subset.
			return ActionResult{
				ID:         a.ID(),
				Status:     StatusFailed,
				ExitCode:   1,
				DurationMs: time.Since(started).Milliseconds(),
				Error: fmt.Sprintf(
					"could not set %s on %q (%v); aborted before running cleanmgr so no unintended handler could execute",
					stateFlagsValue, keyName, err),
			}
		}
		if value == 0 {
			zeroed++
		}
	}

	notes := []string{fmt.Sprintf("profile %s: %d handler(s) enabled, %d zeroed", stateFlagsValue, len(selected), zeroed)}
	notes = append(notes, retiredReasons...)

	proc := runWindowsProcessIdle(ctx, cleanmgrTimeout, cleanmgrIdleLimits, binary, cleanmgrArgs()...)

	// The parent's outcome decides what the sub-actions may claim. Reporting
	// `completed` handlers under a `timed_out` parent is the W05 lab's BUG-3:
	// cleanmgr gives no per-handler result, so the only honest sub-status is
	// the one the run as a whole earned.
	status := StatusCompleted
	var runErr string
	switch {
	case proc.TimedOut:
		status, runErr = StatusTimedOut, proc.Err.Error()
	case proc.IdleStopped:
		// NOT a timeout and not a failure: the tree stopped doing work, which
		// for cleanmgr means the selected handlers are done and only its
		// unreachable progress window is left (#6482).
		notes = append(notes, cleanmgrIdleNote)
	case proc.Err != nil:
		status, runErr = StatusFailed, proc.Err.Error()
	default:
		// Exit code is informational only — see the session-0 caveat above.
	}

	subResults := make([]SubActionRun, 0, len(selected)+len(retired))
	for _, handler := range selected {
		subResults = append(subResults, SubActionRun{ID: "win_cleanmgr:" + handler.slug, Status: status})
	}
	subResults = append(subResults, retired...)

	return ActionResult{
		ID:         a.ID(),
		SubActions: subResults,
		Status:     status,
		Error:      runErr,
		ExitCode:   proc.ExitCode,
		DurationMs: time.Since(started).Milliseconds(),
		OutputTail: capOutput([]byte(strings.Join(append(notes, proc.Stdout, proc.Stderr), "\n"))),
	}
}

// ---------------------------------------------------------------------------
// win_dism_component_cleanup
// ---------------------------------------------------------------------------

type winDismCleanupAction struct{}

func (winDismCleanupAction) ID() string { return "win_dism_component_cleanup" }

func (a winDismCleanupAction) Describe() ActionInfo {
	return ActionInfo{
		ID:    a.ID(),
		Label: "Component store cleanup (DISM)",
		Description: "Removes superseded components from the WinSxS store. Installed updates stay removable — this never runs /ResetBase. " +
			"Some of the space is only released after the next restart.",
		OS:             "windows",
		RiskFlags:      []string{RiskLongRunning, RiskMayRequireRebootFree},
		AffectsVolumes: []string{},
	}
}

func (winDismCleanupAction) Available(context.Context) (bool, string) {
	if _, ok := resolveWindowsBinary(systemRoot() + dismBinaryRelative); !ok {
		return false, "dism.exe not present"
	}
	return true, ""
}

func (winDismCleanupAction) Estimate(ctx context.Context) (int64, bool, string) {
	binary, ok := resolveWindowsBinary(systemRoot() + dismBinaryRelative)
	if !ok {
		return 0, false, ""
	}
	proc := runWindowsProcess(ctx, windowsEstimateLimit, binary, dismAnalyzeArgs()...)
	bytes, known, recommended := parseDismAnalyze(proc.Stdout)
	if !known {
		return 0, false, ""
	}
	detail := "heuristic: DISM /AnalyzeComponentStore reports component-store overhead, which is not the same as what the cleanup frees"
	if !recommended {
		detail += "; Windows does not currently recommend this cleanup"
	}
	return bytes, true, detail
}

func (a winDismCleanupAction) Run(ctx context.Context, _ Params) ActionResult {
	binary, ok := resolveWindowsBinary(systemRoot() + dismBinaryRelative)
	if !ok {
		return ActionResult{ID: a.ID(), Status: StatusUnavailable, ExitCode: 1, Error: "dism.exe not present"}
	}
	return resultFromProc(a.ID(), runWindowsProcess(ctx, dismCleanupTimeout, binary, dismCleanupArgs()...))
}

func windowsActions() []Action {
	return []Action{winCleanmgrAction{}, winDismCleanupAction{}}
}
