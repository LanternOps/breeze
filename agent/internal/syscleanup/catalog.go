package syscleanup

import (
	"context"
	"fmt"
	"runtime"
	"time"

	"github.com/breeze-rmm/agent/internal/maintenance"
)

// estimateBudget caps the WHOLE list call's estimation phase (spec §7.3).
// Estimates run concurrently; whatever has not answered when the budget
// expires reports estimateKnown:false. A var so tests can shrink it.
var estimateBudget = 3 * time.Minute

// CatalogAction is one row of the list result (spec §7.3).
type CatalogAction struct {
	ID                string          `json:"id"`
	Label             string          `json:"label"`
	Description       string          `json:"description"`
	OS                string          `json:"os"`
	SubActions        []SubActionInfo `json:"subActions,omitempty"`
	Available         bool            `json:"available"`
	UnavailableReason string          `json:"unavailableReason,omitempty"`
	EstimateBytes     int64           `json:"estimateBytes,omitempty"`
	EstimateKnown     bool            `json:"estimateKnown"`
	EstimateDetail    string          `json:"estimateDetail,omitempty"`
	RiskFlags         []string        `json:"riskFlags"`
	AffectsVolumes    []string        `json:"affectsVolumes"`
}

// ListResult is the system_cleanup_list command result (spec §7.3).
type ListResult struct {
	CatalogVersion int             `json:"catalogVersion"`
	Actions        []CatalogAction `json:"actions"`
	VolumesBefore  []VolumeFree    `json:"volumesBefore"`
}

// RunResult is the system_cleanup_run command result (spec §7.3).
type RunResult struct {
	RunID      string         `json:"runId"`
	Actions    []ActionResult `json:"actions"`
	Volumes    []VolumeDelta  `json:"volumes"`
	FreedBytes int64          `json:"freedBytes"`
}

// subActionProvider is implemented only by win_cleanmgr today. Kept as an
// optional interface rather than a method on Action so the other five actions
// do not carry an empty implementation.
type subActionProvider interface {
	SubActions() []SubActionInfo
}

// platformActionsFn and fixedVolumesFn are the two seams the catalogue tests
// replace. Everything else in this file is real.
var platformActionsFn = platformActions
var fixedVolumesFn = fixedVolumes

// advanceVolumeSample is a test hook, called between the two volume readings
// of a Run. It is a no-op in production.
var advanceVolumeSample = func() {}

// runBudgetForTests overrides RunBudget when positive, so the not_started
// branch can be exercised in milliseconds. Zero in production.
var runBudgetForTests time.Duration

func platformActions() []Action {
	switch runtime.GOOS {
	case "windows":
		return windowsActions()
	case "darwin":
		return darwinActions()
	case "linux":
		return linuxActions()
	default:
		return nil
	}
}

// List builds the catalogue for this device: availability first, then a
// concurrent estimation pass bounded by estimateBudget, then a free-space
// baseline the UI can show next to each estimate.
func List(ctx context.Context) ListResult {
	actions := platformActionsFn()
	rows := make([]CatalogAction, len(actions))

	estimateCtx, cancel := context.WithTimeout(ctx, estimateBudget)
	defer cancel()

	type estimateResult struct {
		index  int
		bytes  int64
		known  bool
		detail string
	}
	// Workers publish values, never mutate returned rows. Buffering lets a
	// late worker exit even when the caller has already exhausted its budget.
	estimates := make(chan estimateResult, len(actions))
	pending := 0
	for i, action := range actions {
		info := action.Describe()
		available, reason := action.Available(ctx)
		rows[i] = CatalogAction{
			ID:                info.ID,
			Label:             info.Label,
			Description:       info.Description,
			OS:                info.OS,
			Available:         available,
			UnavailableReason: reason,
			RiskFlags:         info.RiskFlags,
			AffectsVolumes:    info.AffectsVolumes,
		}
		if provider, ok := action.(subActionProvider); ok {
			rows[i].SubActions = provider.SubActions()
		}
		if !available {
			// Never price an action the device cannot perform: running DISM
			// or apt to estimate something that will report `unavailable`
			// anyway is pure cost on the endpoint.
			continue
		}

		pending++
		go func(index int, action Action) {
			bytes, known, detail := action.Estimate(estimateCtx)
			estimates <- estimateResult{index, bytes, known, detail}
		}(i, action)
	}

collect:
	for pending > 0 {
		select {
		case result := <-estimates:
			if estimateCtx.Err() != nil {
				break collect
			}
			row := &rows[result.index]
			row.EstimateKnown = result.known
			row.EstimateDetail = result.detail
			if result.known {
				row.EstimateBytes = result.bytes
			}
			pending--
		case <-estimateCtx.Done():
			break collect
		}
	}

	return ListResult{
		CatalogVersion: CatalogVersion,
		Actions:        rows,
		VolumesBefore:  sampleVolumes(fixedVolumesFn()),
	}
}

// selectionFor resolves the requested ids into the actions to run, in
// CATALOGUE order regardless of the order they were requested in.
//
// Two rules the closed catalogue depends on:
//   - an id outside ActionIDs is DROPPED silently here. The server validates
//     first; this is the defence in depth that makes a forged command payload
//     inert (spec §10 item 7).
//   - `win_cleanmgr:<slug>` sub-ids collapse into ONE win_cleanmgr execution
//     carrying those slugs. A bare `win_cleanmgr` means every allowlisted
//     handler present on the device.
func selectionFor(actionIDs []string) []Action {
	requested := make(map[string]bool, len(actionIDs))
	var cleanmgrSlugs []string
	cleanmgrRequested := false
	allCleanmgrHandlers := false
	for _, id := range actionIDs {
		if !IsKnownActionID(id) {
			continue
		}
		if handler, ok := winCleanmgrHandlerBySubID(id); ok {
			cleanmgrRequested = true
			cleanmgrSlugs = append(cleanmgrSlugs, handler.slug)
			continue
		}
		if id == "win_cleanmgr" {
			cleanmgrRequested = true
			allCleanmgrHandlers = true // bare id wins regardless of request order
			continue
		}
		requested[id] = true
	}

	if allCleanmgrHandlers {
		cleanmgrSlugs = nil
	}

	var selected []Action
	for _, action := range platformActionsFn() {
		if action.ID() == "win_cleanmgr" {
			if !cleanmgrRequested {
				continue
			}
			if concrete, ok := action.(winCleanmgrAction); ok {
				concrete.selectedSlugs = cleanmgrSlugs
				selected = append(selected, concrete)
				continue
			}
			selected = append(selected, action)
			continue
		}
		if requested[action.ID()] {
			selected = append(selected, action)
		}
	}
	return selected
}

// actionTimeouts is the per-action wall-clock cap, and — summed — the input to
// the aggregate run budget (spec §13 #14). Mirrored by
// SYSTEM_CLEANUP_ACTION_TIMEOUT_SECONDS in
// packages/shared/src/validators/systemCleanup.ts so the server can size the
// same budget before it queues; shared_ids_test.go compares the two.
var actionTimeouts = map[string]time.Duration{
	"win_cleanmgr":               cleanmgrTimeout,
	"win_dism_component_cleanup": dismCleanupTimeout,
	"mac_tm_local_snapshots":     darwinSnapshotTimeout,
	"mac_brew_cleanup":           darwinBrewTimeout,
	"linux_pkg_cache_clean":      linuxPkgCleanTimeout,
	"linux_pkg_autoremove":       linuxAutoremoveTimeout,
	"linux_journal_vacuum":       linuxJournalVacuumTimeout,
}

// Budget shape (spec §13 #14). Slack covers the probes, the two volume
// samples and process teardown; the cap stops a pathological selection from
// reserving a whole shift.
const (
	runBudgetSlack = 10 * time.Minute
	runBudgetMax   = 3 * time.Hour
)

// ActionTimeout is the wall-clock cap for one action; 0 for an unknown id.
func ActionTimeout(id string) time.Duration {
	if _, ok := winCleanmgrHandlerBySubID(id); ok {
		id = "win_cleanmgr"
	}
	return actionTimeouts[id]
}

// RunBudget sizes one run: Σ the selected actions' own timeouts + 10 minutes,
// capped at 3 h.
//
// A single constant was wrong in both directions: a lone
// `linux_pkg_cache_clean` would hold a two-hour budget for five minutes of
// work, while cleanmgr (60 min) plus DISM (90 min) needs 150 and would have
// been reaped at 120 — mid-DISM, on a component store that is then left
// half-serviced.
//
// Duplicate ids (a bare `win_cleanmgr` alongside its sub-ids) are counted
// once: they collapse into one execution.
func RunBudget(actionIDs []string) time.Duration {
	counted := map[string]bool{}
	total := time.Duration(0)
	for _, id := range actionIDs {
		if !IsKnownActionID(id) {
			continue
		}
		key := id
		if _, ok := winCleanmgrHandlerBySubID(id); ok {
			key = "win_cleanmgr"
		}
		if counted[key] {
			continue
		}
		counted[key] = true
		total += actionTimeouts[key]
	}
	total += runBudgetSlack
	if total > runBudgetMax {
		return runBudgetMax
	}
	return total
}

// Run executes the selected actions SEQUENTIALLY in catalogue order — cleanmgr
// and DISM must not overlap (spec §7.3) — under the process-wide maintenance
// lock and one aggregate budget, and measures the free-space delta across the
// whole run.
//
// Three outcomes that are deliberately distinguishable:
//   - `busy`: another maintenance operation holds the lock. Nothing was
//     attempted, so this is not a failure and a retry is the right next step
//     (spec §13 #4/#12). TryAcquire, not Acquire: a tech is watching a
//     spinner, and blocking inside the run budget would spend it waiting.
//   - `not_started`: the aggregate budget expired before this action's turn.
//     Distinct from `timed_out`, which means the action ran and overran its
//     own cap — the two call for different next steps (re-run the rest vs
//     investigate this one).
//   - `unavailable`: reported without being attempted.
//
// One action failing never stops the next: a tech who selected four things
// wants the other three to happen, and the per-action status is what tells
// them which one did not.
func Run(ctx context.Context, runID string, actionIDs []string, params Params) RunResult {
	selected := selectionFor(actionIDs)

	release, err := maintenance.TryAcquire("system_cleanup_run")
	if err != nil {
		results := make([]ActionResult, 0, len(selected))
		for _, action := range selected {
			results = append(results, ActionResult{
				ID: action.ID(), Status: StatusBusy, ExitCode: 1,
				Error: fmt.Sprintf("%v (holder: %s)", err, maintenance.CurrentOwner()),
			})
		}
		return RunResult{RunID: runID, Actions: results, Volumes: []VolumeDelta{}, FreedBytes: 0}
	}
	defer release()

	budget := RunBudget(actionIDs)
	if runBudgetForTests > 0 {
		budget = runBudgetForTests
	}
	budgetCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	mounts := fixedVolumesFn()
	before := sampleVolumes(mounts)

	results := make([]ActionResult, 0, len(selected))
	for _, action := range selected {
		if budgetCtx.Err() != nil {
			results = append(results, ActionResult{
				ID: action.ID(), Status: StatusNotStarted, ExitCode: 1,
				Error: "the run budget expired before this action started",
			})
			continue
		}
		if available, reason := action.Available(budgetCtx); !available {
			results = append(results, ActionResult{
				ID: action.ID(), Status: StatusUnavailable, ExitCode: 1, Error: reason,
			})
			continue
		}
		results = append(results, action.Run(budgetCtx, params))
	}

	advanceVolumeSample()
	// The measurement is independent of budgetCtx: disk.Usage calls must
	// still happen after a budget expiry, or a run that timed out would
	// report zero freed bytes for work it really did.
	//
	// settleVolumes, not a single sampleVolumes call: btrfs (and other
	// lazy-reclaim filesystems) release freed extents asynchronously, so
	// reading free space once immediately after the cleaner exits can still
	// see the pre-delete figure and report freedBytes=0 for a real deletion
	// (issue #6484).
	after := settleVolumes(mounts)
	volumes, freed := measureFreed(before, after)

	return RunResult{RunID: runID, Actions: results, Volumes: volumes, FreedBytes: freed}
}
