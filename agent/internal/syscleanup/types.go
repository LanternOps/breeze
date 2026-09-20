// Package syscleanup runs a FIXED, VETTED catalogue of OS-native maintenance
// actions (Disk Cleanup v2, spec §7). It is deliberately the opposite of the
// file engine in internal/remote/tools: nothing here is itemised, nothing is
// previewed path-by-path, and estimates may be upper bounds or heuristics.
// The set of things it can do is closed.
//
// Safety model (spec §10 item 7), enforced structurally rather than by review:
//
//   - The only client input is an id drawn from ActionIDs and one bounded
//     integer (Params.JournalVacuumBytes). No string from the wire is ever
//     concatenated into an argv.
//   - Binaries are absolute paths resolved from a fixed candidate list, never
//     a $PATH lookup, and never through a shell.
//   - Every process gets a context deadline, a 16 KiB per-stream output cap,
//     and process-TREE containment so a timeout reaches the real worker rather
//     than the wrapper that spawned it.
//   - Argv builders and output parsers are PURE functions in untagged files,
//     so `go test -race ./internal/syscleanup/...` exercises the entire
//     catalogue's logic on the Linux CI runner. Only syscalls sit behind
//     _windows.go / _darwin.go / _linux.go.
package syscleanup

import "context"

// CatalogVersion is recorded on every cleanup run row. Bump it when the
// meaning of an existing id changes, not when one is added.
const CatalogVersion = 1

// RiskFlag values are rendered as badges by the web panel; removes_packages
// additionally gates the confirm dialog's second checkbox (spec §8).
type RiskFlag = string

const (
	RiskLongRunning           RiskFlag = "long_running"
	RiskMayRequireReboot      RiskFlag = "may_require_reboot"
	RiskMayRequireRebootFree  RiskFlag = "may_require_reboot_free_state"
	RiskRemovesDriverRollback RiskFlag = "removes_driver_rollback"
	RiskRemovesPackages       RiskFlag = "removes_packages"
	// Spec §13 #15. Two disclosures the original catalogue left implicit and
	// that a tech cannot recover from afterwards: deleting Windows.old ends
	// the 10-day "go back to the previous version" window, and deleting the
	// local APFS snapshots removes the only on-disk restore points a Mac has
	// when its Time Machine destination is not attached.
	RiskRemovesOSRollback     RiskFlag = "removes_os_rollback"
	RiskRemovesRecoveryPoints RiskFlag = "removes_recovery_points"
)

// ActionStatus values as they appear in the run result (spec §7.3, §13 #4/#14).
type ActionStatus = string

const (
	StatusCompleted   ActionStatus = "completed"
	StatusFailed      ActionStatus = "failed"
	StatusTimedOut    ActionStatus = "timed_out"
	StatusUnavailable ActionStatus = "unavailable"
	// Another maintenance operation (a concurrent run, a patch job's Homebrew
	// cleanup, DISM) held the process-wide lock. Distinct from `failed`
	// because nothing was attempted and a retry is the right next step.
	StatusBusy ActionStatus = "busy"
	// The aggregate run budget expired before this action's turn. Distinct
	// from `timed_out`, which means THIS action ran and overran its own cap.
	StatusNotStarted ActionStatus = "not_started"
)

// ActionInfo is the static half of an action: everything the catalogue can
// state without touching the machine.
type ActionInfo struct {
	ID             string   `json:"id"`
	Label          string   `json:"label"`
	Description    string   `json:"description"`
	OS             string   `json:"os"`
	RiskFlags      []string `json:"riskFlags"`
	AffectsVolumes []string `json:"affectsVolumes"`
}

// SubActionInfo is one selectable unit inside a composite action — today only
// a cleanmgr handler.
type SubActionInfo struct {
	RiskFlags     []string `json:"riskFlags"`
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	EstimateBytes int64    `json:"estimateBytes,omitempty"`
	EstimateKnown bool     `json:"estimateKnown"`
}

// Params carries the one bounded integer the client may influence. Bounds are
// enforced server-side (packages/shared/src/validators/systemCleanup.ts) AND
// again in linuxJournalVacuumArgs, so a forged payload cannot widen it.
type Params struct {
	JournalVacuumBytes int64 `json:"journalVacuumBytes,omitempty"`
}

// SubActionRun is one sub-action's outcome inside an ActionResult.
type SubActionRun struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

// ActionResult is one action's outcome (spec §7.3). OutputTail is already
// capped by the runner; Error is set for every non-completed status.
type ActionResult struct {
	ID         string         `json:"id"`
	SubActions []SubActionRun `json:"subActions,omitempty"`
	Status     string         `json:"status"`
	ExitCode   int            `json:"exitCode"`
	DurationMs int64          `json:"durationMs"`
	OutputTail string         `json:"outputTail,omitempty"`
	Error      string         `json:"error,omitempty"`
}

// Action is the contract every catalogue entry implements (spec §7.1).
//
// Estimate returns (bytes, known, detail). `known == false` is the honest
// answer for "the parser did not match its fixture shape" and MUST be used in
// preference to reporting 0 with known == true — a confident zero reads as
// "nothing to reclaim" in the UI, which is the exact lie this contract exists
// to prevent.
type Action interface {
	ID() string
	Describe() ActionInfo
	Available(ctx context.Context) (ok bool, reason string)
	Estimate(ctx context.Context) (bytes int64, known bool, detail string)
	Run(ctx context.Context, params Params) ActionResult
}

// winCleanmgrSubIDs are the cleanmgr handler sub-ids in catalogue order. The
// slug -> registry key name mapping lives in windows.go; this list exists here
// so ActionIDs (and therefore the shared TS validator) can be derived from one
// place.
var winCleanmgrSubIDs = []string{
	"win_cleanmgr:update_cleanup",
	"win_cleanmgr:delivery_optimization_files",
	"win_cleanmgr:device_driver_packages",
	"win_cleanmgr:previous_installations",
	"win_cleanmgr:upgrade_discarded_files",
	"win_cleanmgr:windows_upgrade_log_files",
	"win_cleanmgr:setup_log_files",
	"win_cleanmgr:temporary_setup_files",
	"win_cleanmgr:service_pack_cleanup",
	"win_cleanmgr:system_error_memory_dump_files",
	"win_cleanmgr:system_error_minidump_files",
	"win_cleanmgr:windows_error_reporting_files",
	"win_cleanmgr:windows_error_reporting_system_archive_files",
	"win_cleanmgr:windows_error_reporting_system_queue_files",
	"win_cleanmgr:temporary_files",
	"win_cleanmgr:windows_defender",
	"win_cleanmgr:old_chkdsk_files",
	"win_cleanmgr:diagnostic_data_viewer_database_files",
	"win_cleanmgr:branchcache",
	"win_cleanmgr:content_indexer_cleaner",
}

// ActionIDs is every id the server may send, in catalogue (execution) order.
// Mirrored by SYSTEM_CLEANUP_ACTION_IDS in
// packages/shared/src/validators/systemCleanup.ts; shared_ids_test.go proves
// the two lists are identical.
var ActionIDs = func() []string {
	ids := make([]string, 0, 1+len(winCleanmgrSubIDs)+6)
	ids = append(ids, "win_cleanmgr")
	ids = append(ids, winCleanmgrSubIDs...)
	return append(ids,
		"win_dism_component_cleanup",
		"mac_tm_local_snapshots",
		"mac_brew_cleanup",
		"linux_pkg_cache_clean",
		"linux_pkg_autoremove",
		"linux_journal_vacuum",
	)
}()

var knownActionIDs = func() map[string]bool {
	m := make(map[string]bool, len(ActionIDs))
	for _, id := range ActionIDs {
		m[id] = true
	}
	return m
}()

// IsKnownActionID is the agent-side half of the closed-catalogue rule. The
// server validates too (spec §5.3); this is the defence in depth that makes a
// forged command payload inert.
func IsKnownActionID(id string) bool { return knownActionIDs[id] }
