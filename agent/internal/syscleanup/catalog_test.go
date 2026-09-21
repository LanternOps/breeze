package syscleanup

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/maintenance"
)

type fakeAction struct {
	id            string
	available     bool
	reason        string
	estimate      int64
	known         bool
	estimateDelay time.Duration
	estimateGate  <-chan struct{}
	estimateDone  chan<- struct{}
	runDelay      time.Duration
	status        string
	ran           *int32
	order         *[]string
}

func (f fakeAction) ID() string { return f.id }
func (f fakeAction) Describe() ActionInfo {
	return ActionInfo{ID: f.id, Label: "L " + f.id, Description: "D " + f.id, OS: "linux",
		RiskFlags: []string{}, AffectsVolumes: []string{"/"}}
}
func (f fakeAction) Available(context.Context) (bool, string) { return f.available, f.reason }
func (f fakeAction) Estimate(ctx context.Context) (int64, bool, string) {
	if f.estimateGate != nil {
		<-f.estimateGate
		defer close(f.estimateDone)
	}
	if f.estimateDelay > 0 {
		select {
		case <-time.After(f.estimateDelay):
		case <-ctx.Done():
			return 0, false, ""
		}
	}
	return f.estimate, f.known, "detail " + f.id
}
func (f fakeAction) Run(ctx context.Context, _ Params) ActionResult {
	if f.order != nil {
		*f.order = append(*f.order, f.id)
	}
	if f.ran != nil {
		atomic.AddInt32(f.ran, 1)
	}
	if f.runDelay > 0 {
		select {
		case <-time.After(f.runDelay):
		case <-ctx.Done():
		}
	}
	status := f.status
	if status == "" {
		status = StatusCompleted
	}
	return ActionResult{ID: f.id, Status: status, ExitCode: 0}
}

func withActions(t *testing.T, actions []Action) {
	t.Helper()
	original := platformActionsFn
	t.Cleanup(func() { platformActionsFn = original })
	platformActionsFn = func() []Action { return actions }
}

func withVolumes(t *testing.T, before, after []VolumeFree) {
	t.Helper()
	originalMounts, originalUsage, originalAdvance := fixedVolumesFn, usageFreeFn, advanceVolumeSample
	t.Cleanup(func() {
		fixedVolumesFn, usageFreeFn, advanceVolumeSample = originalMounts, originalUsage, originalAdvance
	})

	mounts := make([]string, 0, len(before))
	for _, volume := range before {
		mounts = append(mounts, volume.Mount)
	}
	fixedVolumesFn = func() []string { return mounts }

	var call int32
	afterByMount := map[string]int64{}
	for _, volume := range after {
		afterByMount[volume.Mount] = volume.FreeBytes
	}
	beforeByMount := map[string]int64{}
	for _, volume := range before {
		beforeByMount[volume.Mount] = volume.FreeBytes
	}
	usageFreeFn = func(mount string) (int64, error) {
		if atomic.LoadInt32(&call) == 0 {
			return beforeByMount[mount], nil
		}
		value, ok := afterByMount[mount]
		if !ok {
			return 0, errors.New("gone")
		}
		return value, nil
	}
	t.Cleanup(func() { atomic.StoreInt32(&call, 0) })
	// Flip to the "after" sample once Run has taken its first reading.
	advanceVolumeSample = func() { atomic.StoreInt32(&call, 1) }
}

func TestListReportsEveryActionWithItsAvailability(t *testing.T) {
	withActions(t, []Action{
		fakeAction{id: "a", available: true, estimate: 100, known: true},
		fakeAction{id: "b", available: false, reason: "dism.exe not present"},
	})
	withVolumes(t, []VolumeFree{{Mount: "/", FreeBytes: 10}}, []VolumeFree{{Mount: "/", FreeBytes: 10}})

	got := List(context.Background())
	if got.CatalogVersion != CatalogVersion {
		t.Fatalf("CatalogVersion = %d", got.CatalogVersion)
	}
	if len(got.Actions) != 2 {
		t.Fatalf("len(Actions) = %d, want 2", len(got.Actions))
	}
	if !got.Actions[0].Available || got.Actions[0].EstimateBytes != 100 || !got.Actions[0].EstimateKnown {
		t.Fatalf("Actions[0] = %+v", got.Actions[0])
	}
	if got.Actions[1].Available || got.Actions[1].UnavailableReason != "dism.exe not present" {
		t.Fatalf("Actions[1] = %+v", got.Actions[1])
	}
	// An unavailable action is never estimated — running dism to price an
	// action the device cannot perform is pure cost.
	if got.Actions[1].EstimateKnown {
		t.Error("an unavailable action must not report a known estimate")
	}
	if len(got.VolumesBefore) != 1 || got.VolumesBefore[0].Mount != "/" {
		t.Fatalf("VolumesBefore = %+v", got.VolumesBefore)
	}
}

// Estimation is concurrent with an overall 3-minute cap; an action whose
// estimate times out reports estimateKnown:false rather than stalling the
// whole list (spec §7.3).
func TestListCapsTheOverallEstimateBudget(t *testing.T) {
	withActions(t, []Action{
		fakeAction{id: "fast", available: true, estimate: 7, known: true},
		fakeAction{id: "slow", available: true, estimate: 9, known: true, estimateDelay: 5 * time.Second},
	})
	withVolumes(t, nil, nil)

	original := estimateBudget
	t.Cleanup(func() { estimateBudget = original })
	estimateBudget = 150 * time.Millisecond

	started := time.Now()
	got := List(context.Background())
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("List blocked for %s past its %s budget", elapsed, estimateBudget)
	}
	byID := map[string]CatalogAction{}
	for _, action := range got.Actions {
		byID[action.ID] = action
	}
	if !byID["fast"].EstimateKnown || byID["fast"].EstimateBytes != 7 {
		t.Fatalf("fast = %+v", byID["fast"])
	}
	if byID["slow"].EstimateKnown {
		t.Fatalf("slow must report estimateKnown:false after the budget expires; got %+v", byID["slow"])
	}
}

// Sequential, in catalogue order — cleanmgr and DISM must never overlap
// (spec §7.3).
func TestRunExecutesSequentiallyInCatalogueOrder(t *testing.T) {
	var order []string
	withActions(t, []Action{
		fakeAction{id: "linux_pkg_cache_clean", available: true, order: &order},
		fakeAction{id: "linux_pkg_autoremove", available: true, order: &order},
		fakeAction{id: "linux_journal_vacuum", available: true, order: &order},
	})
	withVolumes(t, []VolumeFree{{Mount: "/", FreeBytes: 1_000}}, []VolumeFree{{Mount: "/", FreeBytes: 4_000}})

	got := Run(context.Background(), "run-1", []string{"linux_journal_vacuum", "linux_pkg_cache_clean"}, Params{})
	if strings.Join(order, ",") != "linux_pkg_cache_clean,linux_journal_vacuum" {
		t.Fatalf("execution order = %v, want catalogue order [linux_pkg_cache_clean linux_journal_vacuum] regardless of request order", order)
	}
	if got.RunID != "run-1" || len(got.Actions) != 2 {
		t.Fatalf("RunResult = %+v", got)
	}
	if got.FreedBytes != 3_000 {
		t.Fatalf("FreedBytes = %d, want the measured 3000", got.FreedBytes)
	}
}

// One failing action does not stop the next (spec §7.3).

func TestRunContinuesPastAFailedAction(t *testing.T) {
	var ran int32
	withActions(t, []Action{
		fakeAction{id: "linux_pkg_cache_clean", available: true, status: StatusFailed, ran: &ran},
		fakeAction{id: "linux_pkg_autoremove", available: true, ran: &ran},
	})
	withVolumes(t, nil, nil)

	got := Run(context.Background(), "run-2", []string{"linux_pkg_cache_clean", "linux_pkg_autoremove"}, Params{})
	if atomic.LoadInt32(&ran) != 2 {
		t.Fatalf("ran %d actions, want 2 — a failure must not stop the run", ran)
	}
	if got.Actions[0].Status != StatusFailed || got.Actions[1].Status != StatusCompleted {
		t.Fatalf("Actions = %+v", got.Actions)
	}
}

// An unavailable action is reported, not attempted.
func TestRunReportsUnavailableWithoutExecuting(t *testing.T) {
	var ran int32
	withActions(t, []Action{fakeAction{id: "linux_pkg_cache_clean", available: false, reason: "tmutil not present", ran: &ran}})
	withVolumes(t, nil, nil)

	got := Run(context.Background(), "run-3", []string{"linux_pkg_cache_clean"}, Params{})
	if atomic.LoadInt32(&ran) != 0 {
		t.Fatal("an unavailable action must not be executed")
	}
	if got.Actions[0].Status != StatusUnavailable || got.Actions[0].Error != "tmutil not present" {
		t.Fatalf("Actions[0] = %+v", got.Actions[0])
	}
}

// Spec §13 #14: Σ the selected actions' own timeouts + 10 min, capped at 3 h.
func TestRunBudgetIsTheSumOfSelectedTimeoutsPlusSlack(t *testing.T) {
	cases := []struct {
		ids  []string
		want time.Duration
	}{
		{[]string{"linux_pkg_cache_clean"}, 5*time.Minute + 10*time.Minute},
		{[]string{"linux_pkg_cache_clean", "linux_journal_vacuum"}, 5*time.Minute + 5*time.Minute + 10*time.Minute},
		// cleanmgr 60 + DISM 90 + 10 = 160 min. A flat two-hour constant
		// would have reaped this mid-DISM.
		{[]string{"win_cleanmgr", "win_dism_component_cleanup"}, 160 * time.Minute},
		// A bare win_cleanmgr and its sub-ids are ONE execution, counted once.
		{[]string{"win_cleanmgr", "win_cleanmgr:update_cleanup", "win_cleanmgr:setup_log_files"}, 70 * time.Minute},
		// Unknown ids contribute nothing.
		{[]string{"linux_pkg_cache_clean", "not_an_action"}, 15 * time.Minute},
		{nil, 10 * time.Minute},
	}
	for _, tc := range cases {
		if got := RunBudget(tc.ids); got != tc.want {
			t.Errorf("RunBudget(%v) = %s, want %s", tc.ids, got, tc.want)
		}
	}
	// Cap: every action at once still cannot exceed three hours.
	if got := RunBudget(ActionIDs); got != 3*time.Hour {
		t.Fatalf("RunBudget(everything) = %s, want the 3h cap", got)
	}
}

// Spec §13 #4/#12: a second run while another maintenance operation holds the
// lock touches NOTHING and says `busy` — not `failed`, because nothing was
// attempted and a retry is the right next step.
func TestRunReportsBusyWithoutTouchingAnythingWhenTheLockIsHeld(t *testing.T) {
	var ran int32
	withActions(t, []Action{fakeAction{id: "linux_pkg_cache_clean", available: true, ran: &ran}})
	withVolumes(t, nil, nil)

	release, err := maintenance.TryAcquire("brew_cleanup")
	if err != nil {
		t.Fatal(err)
	}
	defer release()

	got := Run(context.Background(), "run-5", []string{"linux_pkg_cache_clean"}, Params{})
	if atomic.LoadInt32(&ran) != 0 {
		t.Fatal("no action may execute while the maintenance lock is held")
	}
	if len(got.Actions) != 1 || got.Actions[0].Status != StatusBusy {
		t.Fatalf("Actions = %+v, want a single busy entry", got.Actions)
	}
	if !strings.Contains(got.Actions[0].Error, "brew_cleanup") {
		t.Fatalf("the busy error should name the holder; got %q", got.Actions[0].Error)
	}
}

// Spec §13 #14: an action the aggregate budget never reached is `not_started`,
// which is a different fact from `timed_out` (that one ran and overran).
func TestRunReportsNotStartedForActionsTheBudgetNeverReached(t *testing.T) {
	var ran int32
	withActions(t, []Action{
		fakeAction{id: "linux_pkg_cache_clean", available: true, runDelay: 400 * time.Millisecond, ran: &ran},
		fakeAction{id: "linux_pkg_autoremove", available: true, ran: &ran},
	})
	withVolumes(t, []VolumeFree{{Mount: "/", FreeBytes: 1}}, []VolumeFree{{Mount: "/", FreeBytes: 2}})

	original := runBudgetForTests
	t.Cleanup(func() { runBudgetForTests = original })
	runBudgetForTests = 150 * time.Millisecond

	got := Run(context.Background(), "run-6", []string{"linux_pkg_cache_clean", "linux_pkg_autoremove"}, Params{})
	if len(got.Actions) != 2 {
		t.Fatalf("Actions = %+v", got.Actions)
	}
	if got.Actions[1].Status != StatusNotStarted {
		t.Fatalf("Actions[1].Status = %q, want not_started", got.Actions[1].Status)
	}
	// The measurement still runs after a budget expiry, or a timed-out run
	// would report zero bytes for work it really did.
	if got.FreedBytes != 1 {
		t.Fatalf("FreedBytes = %d, want the measured 1 even after the budget expired", got.FreedBytes)
	}
}

// The closed catalogue, enforced agent-side as defence in depth behind the
// server's own validation (spec §5.3, §10 item 7).
func TestRunDropsAnyIDOutsideTheCatalogue(t *testing.T) {
	var ran int32
	withActions(t, []Action{fakeAction{id: "linux_journal_vacuum", available: true, ran: &ran}})
	withVolumes(t, nil, nil)

	got := Run(context.Background(), "run-4", []string{"linux_journal_vacuum", "rm -rf /", "win_cleanmgr:DownloadsFolder"}, Params{})
	if len(got.Actions) != 1 || got.Actions[0].ID != "linux_journal_vacuum" {
		t.Fatalf("Actions = %+v, want only the catalogue id", got.Actions)
	}
	if atomic.LoadInt32(&ran) != 1 {
		t.Fatalf("ran = %d, want 1", ran)
	}
}

func TestListDoesNotPublishEstimatesAfterReturning(t *testing.T) {
	gate, done := make(chan struct{}), make(chan struct{})
	withActions(t, []Action{fakeAction{id: "slow", available: true, estimate: 9, known: true, estimateGate: gate, estimateDone: done}})
	withVolumes(t, nil, nil)
	original := estimateBudget
	t.Cleanup(func() { estimateBudget = original })
	estimateBudget = 10 * time.Millisecond
	got := List(context.Background())
	close(gate)
	<-done
	if got.Actions[0].EstimateKnown || got.Actions[0].EstimateBytes != 0 {
		t.Fatalf("late estimate changed returned row: %+v", got.Actions[0])
	}
}

func TestSelectionBareCleanmgrWinsInEitherOrder(t *testing.T) {
	withActions(t, []Action{winCleanmgrAction{}})
	for _, ids := range [][]string{
		{"win_cleanmgr", "win_cleanmgr:setup_log_files"},
		{"win_cleanmgr:setup_log_files", "win_cleanmgr"},
	} {
		got := selectionFor(ids)
		if len(got) != 1 || len(got[0].(winCleanmgrAction).selectedSlugs) != 0 {
			t.Fatalf("selectionFor(%v) = %+v, want all handlers", ids, got)
		}
	}
}
